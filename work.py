from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import cv2
import face_recognition
from ultralytics import YOLO
import numpy as np
import os
import base64
import json
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load configuration from environment
AUTHORIZED_FACE_DIR = os.getenv("AUTHORIZED_FACE_DIR", "authorized_faces")
CONF_THRESHOLD = float(os.getenv("CONF_THRESHOLD", "0.4"))
FACE_TOLERANCE = float(os.getenv("FACE_TOLERANCE", "0.45"))
VIOLATING_OBJECTS = os.getenv("VIOLATING_OBJECTS", "cell phone,camera,laptop,tv,monitor").split(",")
VIOLATING_OBJECTS = [obj.strip() for obj in VIOLATING_OBJECTS]
YOLO_MODEL_PATH = os.getenv("YOLO_MODEL_PATH", "yolov8n.pt")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

yolo_model = None
authorized_encodings = []
executor = ThreadPoolExecutor(max_workers=4)


def load_authorized_faces():
    encodings = []
    if not os.path.exists(AUTHORIZED_FACE_DIR):
        return encodings
    
    for fname in os.listdir(AUTHORIZED_FACE_DIR):
        if not fname.lower().endswith(('.jpg', '.jpeg', '.png')):
            continue
        fpath = os.path.join(AUTHORIZED_FACE_DIR, fname)
        try:
            img = face_recognition.load_image_file(fpath)
            e = face_recognition.face_encodings(img)
            if e:
                encodings.append(e[0])
                print(f"✓ Loaded: {fname}")
        except:
            continue
    return encodings


def process_frame_sync(frame_data, face_auth, require_single):
    global yolo_model, authorized_encodings
    
    try:
        nparr = np.frombuffer(base64.b64decode(frame_data), np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return {"status": "error", "message": "Failed to decode frame"}
        
        if yolo_model is None:
            yolo_model = YOLO(YOLO_MODEL_PATH)
        
        results = yolo_model(frame, verbose=False)[0]
        person_boxes = []
        detected_devices = []
        
        if results and results.boxes:
            for box in results.boxes:
                class_id = int(box.cls[0])
                label = yolo_model.names[class_id].lower()
                conf = float(box.conf[0])
                
                if conf < CONF_THRESHOLD:
                    continue
                
                if label == 'person':
                    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy().astype(int)
                    person_boxes.append((x1, y1, x2, y2, conf))
                elif label in VIOLATING_OBJECTS:
                    detected_devices.append(label)
        
        total_persons = len(person_boxes)
        has_devices = len(detected_devices) > 0
        
        if not face_auth:
            if has_devices:
                return {
                    "status": "invalid",
                    "message": f"Device detected: {', '.join(set(detected_devices))}",
                    "persons": total_persons
                }
            
            if require_single:
                if total_persons == 1:
                    return {"status": "valid", "message": "Privacy maintained", "persons": total_persons}
                elif total_persons == 0:
                    return {"status": "invalid", "message": "No people detected", "persons": total_persons}
                else:
                    return {"status": "invalid", "message": f"{total_persons} people (need 1)", "persons": total_persons}
            else:
                if total_persons >= 1:
                    return {"status": "valid", "message": "Privacy maintained", "persons": total_persons}
                else:
                    return {"status": "invalid", "message": "No people detected", "persons": total_persons}
        
        if len(authorized_encodings) == 0:
            return {"status": "invalid", "message": "No authorized faces", "persons": total_persons}
        
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        face_locations = face_recognition.face_locations(rgb)
        face_encodings = face_recognition.face_encodings(rgb, face_locations)
        
        authorized_count = 0
        for fe in face_encodings:
            matches = face_recognition.compare_faces(authorized_encodings, fe, tolerance=FACE_TOLERANCE)
            if True in matches:
                authorized_count += 1
        
        unauthorized = len(face_encodings) - authorized_count
        
        if has_devices:
            return {
                "status": "invalid",
                "message": f"Device detected: {', '.join(set(detected_devices))}",
                "persons": total_persons,
                "authorized": authorized_count
            }
        
        if unauthorized > 0:
            return {
                "status": "invalid",
                "message": f"{unauthorized} unauthorized person(s)",
                "persons": total_persons,
                "authorized": authorized_count
            }
        
        if require_single:
            if total_persons == 1 and authorized_count == 1:
                return {
                    "status": "valid",
                    "message": "Authenticated - Privacy maintained",
                    "persons": total_persons,
                    "authorized": authorized_count
                }
            else:
                return {
                    "status": "invalid",
                    "message": "Single authorized person required",
                    "persons": total_persons,
                    "authorized": authorized_count
                }
        else:
            if total_persons >= 1 and unauthorized == 0:
                return {
                    "status": "valid",
                    "message": "Authenticated - Privacy maintained",
                    "persons": total_persons,
                    "authorized": authorized_count
                }
            else:
                return {
                    "status": "invalid",
                    "message": "All persons must be authorized",
                    "persons": total_persons,
                    "authorized": authorized_count
                }
        
    except Exception as e:
        return {"status": "error", "message": str(e)}


async def process_frame_async(frame_data, face_auth, require_single):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        executor, process_frame_sync, frame_data, face_auth, require_single
    )
    return result


@app.on_event("startup")
async def startup():
    global authorized_encodings
    print("🚀 Starting server...")
    print("📦 Loading YOLO model...")
    global yolo_model
    yolo_model = YOLO(YOLO_MODEL_PATH)
    print("✅ YOLO loaded")
    print("👤 Loading authorized faces...")
    authorized_encodings = load_authorized_faces()
    print(f"✅ Loaded {len(authorized_encodings)} authorized face(s)")
    print("✅ Server ready at http://localhost:8000")


@app.get("/")
async def get_home():
    try:
        with open("index.html", "r") as f:
            return HTMLResponse(content=f.read())
    except:
        return {"message": "Place index.html in the same directory as app.py"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("📱 Client connected")
    
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            
            result = await process_frame_async(
                msg.get('frame', ''),
                msg.get('faceAuth', False),
                msg.get('requireSingle', True)
            )
            
            await websocket.send_text(json.dumps(result))
    except WebSocketDisconnect:
        print("📱 Client disconnected")
    except Exception as e:
        print(f"❌ Error: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)