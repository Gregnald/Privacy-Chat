from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorGridFSBucket
from pydantic import BaseModel
from datetime import datetime, timezone
from bson import ObjectId
from typing import Optional
import json
import io
from PIL import Image, ImageFilter
from contextlib import asynccontextmanager
from dotenv import load_dotenv
import os

load_dotenv()

from work import process_frame_async, yolo_model, authorized_encodings, load_authorized_faces, YOLO_MODEL_PATH
db_client = None
db = None
messages_collection = None
fs = None

MONGO_URL = os.getenv("MONGO_URL")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_client, db, messages_collection, fs
    db_client = AsyncIOMotorClient(MONGO_URL)
    db = db_client.privacy_chat
    messages_collection = db.messages
    fs = AsyncIOMotorGridFSBucket(db)
    
    import work
    print(" Starting server...")
    print(" Loading YOLO model...")
    work.yolo_model = work.YOLO(YOLO_MODEL_PATH)
    print(" YOLO loaded")
    print(" Loading authorized faces...")
    work.authorized_encodings = load_authorized_faces()
    print(f" Loaded {len(work.authorized_encodings)} authorized face(s)")
    
    yield
    db_client.close()

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[dict] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append({"ws": websocket, "username": None})

    async def disconnect(self, websocket: WebSocket):
        self.active_connections = [c for c in self.active_connections if c.get("ws") is not websocket]
        try:
            await self.broadcast_user_list()
        except:
            pass

    async def set_username(self, websocket: WebSocket, username: str):
        for c in self.active_connections:
            if c.get("ws") is websocket:
                c["username"] = username
                break
        try:
            await self.broadcast_user_list()
        except:
            pass

    async def broadcast_personalized(self, message: dict):
        data = message.get("data", {})
        sender = data.get("sender")
        receiver = data.get("receiver")
        is_private = bool(data.get("private"))

        for conn in list(self.active_connections):
            ws = conn.get("ws")
            uname = conn.get("username")
            try:
                payload = {"type": message.get("type"), "data": dict(data)}

                if is_private and receiver:
                    if uname != sender and uname != receiver:
                        payload["data"]["status"] = "invalid"
                await ws.send_json(payload)
            except:
                pass

    async def broadcast_user_list(self):
        users = [c.get("username") for c in self.active_connections if c.get("username")]
        payload = {"type": "user_list", "data": users}
        for conn in list(self.active_connections):
            ws = conn.get("ws")
            try:
                await ws.send_json(payload)
            except:
                pass

manager = ConnectionManager()

class TextMessage(BaseModel):
    sender: str
    text: str
    private: bool = False
    status: str = "valid"

class ToggleStatus(BaseModel):
    status: str

@app.post("/upload")
async def upload_file(
    file: UploadFile = File(...), 
    sender: str = Form(""), 
    text: str = Form(""), 
    private: str = Form("false"), 
    status: str = Form("valid"), 
    receiver: str = Form("")
):
    is_private = private.lower() == "true"
    receiver_id = receiver if receiver and receiver.strip() else None
    
    print(f"📤 Upload - Sender: '{sender}' (length: {len(sender)}), Text: '{text}', Private: {is_private}, Receiver: '{receiver_id}'")
    
    if not sender or not sender.strip():
        raise HTTPException(status_code=400, detail="Sender is required")
    
    contents = await file.read()
    file_id = await fs.upload_from_stream(
        file.filename,
        io.BytesIO(contents),
        metadata={
            "content_type": file.content_type,
            "sender": sender
        }
    )
    
    message_doc = {
        "sender": sender,
        "text": text if text and text.strip() else "",
        "file_id": str(file_id),
        "filename": file.filename,
        "content_type": file.content_type,
        "private": is_private,
        "status": status,
        "receiver": receiver_id,
        "timestamp": datetime.now(timezone.utc)
    }
    
    result = await messages_collection.insert_one(message_doc)
    message_doc["_id"] = str(result.inserted_id)
    message_doc["timestamp"] = message_doc["timestamp"].isoformat()
    
    await manager.broadcast_personalized({
        "type": "message",
        "data": message_doc
    })
    
    return {"message_id": str(result.inserted_id), "file_id": str(file_id)}

@app.get("/file/{file_id}")
async def get_file(file_id: str, viewer: Optional[str] = None):
    try:
        grid_out = await fs.open_download_stream(ObjectId(file_id))
        contents = await grid_out.read()
        metadata = grid_out.metadata or {}
        content_type = metadata.get("content_type", "application/octet-stream")
        sender = metadata.get("sender", "")
        
        message = await messages_collection.find_one({"file_id": file_id})
        is_private = message.get("private") if message else False
        receiver = message.get("receiver") if message else None
        should_blur = False

        if message:
            if is_private:
                if viewer not in [sender, receiver]:
                    should_blur = True
            else:
                if viewer != sender and message.get("status") == "invalid":
                    should_blur = True
            
            if should_blur and content_type.startswith("image/"):
                img = Image.open(io.BytesIO(contents))
                img = img.filter(ImageFilter.GaussianBlur(radius=20))
                img_byte_arr = io.BytesIO()
                img.save(img_byte_arr, format=img.format or 'PNG')
                contents = img_byte_arr.getvalue()
        
        return StreamingResponse(
            io.BytesIO(contents),
            media_type=content_type,
            headers={"Content-Disposition": f"inline; filename={grid_out.filename}"}
        )
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/toggle_status/{msg_id}")
async def toggle_status(msg_id: str, data: ToggleStatus):
    result = await messages_collection.update_one(
        {"_id": ObjectId(msg_id)},
        {"$set": {"status": data.status}}
    )
    
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Message not found")
    
    message = await messages_collection.find_one({"_id": ObjectId(msg_id)})
    message["_id"] = str(message["_id"])
    message["timestamp"] = message["timestamp"].isoformat()
    await manager.broadcast_personalized({
        "type": "status_update",
        "data": message
    })
    
    return {"success": True}

@app.get("/messages")
async def get_messages(viewer: Optional[str] = None):
    messages = []
    cursor = messages_collection.find().sort("timestamp", 1)
    async for msg in cursor:
        msg["_id"] = str(msg["_id"])
        msg["timestamp"] = msg["timestamp"].isoformat()
        if msg.get("private") and viewer and viewer not in [msg.get("sender"), msg.get("receiver")]:
            msg["status"] = "invalid"
        messages.append(msg)
    return messages


@app.get("/users")
async def get_users():
    users = [c.get("username") for c in manager.active_connections if c.get("username")]
    return users

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "register":
                username = data.get("username")
                if username:
                    await manager.set_username(websocket, username)
                continue

            if data.get("type") == "message":
                message_doc = {
                    "sender": data["sender"],
                    "text": data.get("text"),
                    "file_id": None,
                    "private": data.get("private", False),
                    "receiver": data.get("receiver"),
                    "status": data.get("status", "valid"),
                    "timestamp": datetime.now(timezone.utc)
                }

                result = await messages_collection.insert_one(message_doc)
                message_doc["_id"] = str(result.inserted_id)
                message_doc["timestamp"] = message_doc["timestamp"].isoformat()

                await manager.broadcast_personalized({
                    "type": "message",
                    "data": message_doc
                })
    except WebSocketDisconnect:
        await manager.disconnect(websocket)


@app.websocket("/ws/video")
async def video_websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    # print("Video validation client connected")
    
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            
            result = await process_frame_async(
                msg.get('frame', ''),
                msg.get('faceAuth', False),
                msg.get('requireSingle', True)
            )
            
            result['message_id'] = msg.get('message_id')
            
            await websocket.send_text(json.dumps(result))
    except WebSocketDisconnect:
        pass
        # print(" Video validation client disconnected")
    except Exception as e:
        print(f" Video validation error: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)