import React, { useState, useEffect, useRef } from 'react';
import { Send, Paperclip, Lock, Unlock, Image } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws';
const VIDEO_WS_URL = import.meta.env.VITE_VIDEO_WS_URL || 'ws://localhost:8000/ws/video';

export default function PrivacyChat() {
  const [username, setUsername] = useState('');
  const [isJoined, setIsJoined] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [receiverId, setReceiverId] = useState('');
  const [users, setUsers] = useState([]);
  const [ws, setWs] = useState(null);
  const [videoWs, setVideoWs] = useState(null);
  const [validatingMessageId, setValidatingMessageId] = useState(null);
  const [temporaryInvalidMessages, setTemporaryInvalidMessages] = useState(new Set());
  const [validationStatus, setValidationStatus] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const animationFrameRef = useRef(null);
  const messagesEndRef = useRef(null);
  const skipScrollRef = useRef(false);
  const isAtBottomRef = useRef(true);
  const newMessageRef = useRef(false);
  const lastMessageIsLocalRef = useRef(false);
  const initialLoadRef = useRef(true);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);

  useEffect(() => {
    if (isJoined) {
      connectWebSocket();
      loadMessages();
    }
    return () => {
      if (ws) ws.close();
      if (videoWs) videoWs.close();
      stopCamera();
    };
  }, [isJoined]);

  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      newMessageRef.current = false;
      return;
    }

    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      scrollToBottom();
      return;
    }

    if (newMessageRef.current) {
      newMessageRef.current = false;
      if (lastMessageIsLocalRef.current || isAtBottomRef.current) {
        scrollToBottom();
      }
      return;
    }
  }, [messages]);

  const connectWebSocket = () => {
    const websocket = new WebSocket(WS_URL);
    
    websocket.onopen = () => {
      console.log('Connected');
      websocket.send(JSON.stringify({ type: 'register', username }));
    };
    
    websocket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'user_list') {
        setUsers(message.data || []);
        return;
      }
      if (message.type === 'message') {
        console.log('Received message:', message.data);
        newMessageRef.current = true;
        lastMessageIsLocalRef.current = message.data.sender === username;
        setMessages(prev => [...prev, message.data]);
      } else if (message.type === 'status_update') {
        skipScrollRef.current = true;
        setMessages(prev => prev.map(msg => 
          msg._id === message.data._id ? message.data : msg
        ));
      }
    };
    
    setWs(websocket);
  };

  const loadMessages = async () => {
    try {
      const response = await fetch(`${API_URL}/messages?viewer=${encodeURIComponent(username)}`);
      const data = await response.json();
      setMessages(data);
      try {
        const uresp = await fetch(`${API_URL}/users`);
        const udata = await uresp.json();
        setUsers(udata || []);
      } catch (e) {
        console.error('Error loading users:', e);
      }
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleScroll = (e) => {
    const target = e.target;
    const atBottom = (target.scrollHeight - target.scrollTop - target.clientHeight) <= 100;
    isAtBottomRef.current = atBottom;
    
    if (validatingMessageId) {
      stopCamera();
    }
  };

  const stopCamera = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoWs && videoWs.readyState === WebSocket.OPEN) {
      videoWs.close();
      setVideoWs(null);
    }
    setValidatingMessageId(null);
    setValidationStatus('');
    setTemporaryInvalidMessages(new Set());
  };

  const startVideoValidation = async (messageId) => {
    try {
      stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480 } 
      });
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await new Promise((resolve) => {
          videoRef.current.onloadedmetadata = () => {
            videoRef.current.play();
            resolve();
          };
        });
      }

      const videoWebsocket = new WebSocket(VIDEO_WS_URL);
      
      videoWebsocket.onopen = () => {
        console.log('📹 Video validation connected');
        setValidatingMessageId(messageId);
        setTimeout(() => {
          sendVideoFrames(videoWebsocket, messageId);
        }, 500);
      };
      
      videoWebsocket.onmessage = (event) => {
        const result = JSON.parse(event.data);
        const msgId = result.message_id;
        
        console.log('📹 Validation result:', result.status, 'for message:', msgId);
        setValidationStatus(result.message || result.status);
        
        if (result.status === 'valid') {
          setTemporaryInvalidMessages(prev => {
            const newSet = new Set(prev);
            newSet.delete(msgId);
            return newSet;
          });
        } else if (result.status === 'invalid' || result.status === 'error') {
          setTemporaryInvalidMessages(prev => new Set(prev).add(msgId));
        }
      };
      
      videoWebsocket.onerror = (error) => {
        console.error('📹 Video WebSocket error:', error);
        stopCamera();
      };
      
      videoWebsocket.onclose = () => {
        console.log('📹 Video WebSocket closed');
      };
      
      setVideoWs(videoWebsocket);
    } catch (error) {
      console.error('Error starting camera:', error);
      alert('Failed to access camera. Please allow camera permissions.');
    }
  };

  const sendVideoFrames = (websocket, messageId) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    const captureFrame = () => {
      if (!streamRef.current || !websocket || websocket.readyState !== WebSocket.OPEN) {
        return;
      }
      
      if (videoRef.current && videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        context.drawImage(videoRef.current, 0, 0);
        
        const frameData = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
        
        websocket.send(JSON.stringify({
          frame: frameData,
          message_id: messageId,
          faceAuth: false,
          requireSingle: true
        }));
      }
      
      animationFrameRef.current = setTimeout(captureFrame, 33);
    };
    
    captureFrame();
  };

  const handlePrivateMessageClick = (msg) => {
    const isReceiver = msg.private && msg.receiver === username;
    if (isReceiver) {
      startVideoValidation(msg._id);
    }
  };

  const handleJoin = () => {
    if (username.trim()) {
      setIsJoined(true);
    }
  };

  const sendMessage = async () => {
    if (!inputText.trim() && !selectedFile) return;
    
    if (isPrivate && !receiverId) {
      alert('Select a recipient for private messages');
      return;
    }

    if (selectedFile) {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('sender', username);
      formData.append('text', inputText.trim());
      formData.append('private', isPrivate);
      formData.append('receiver', receiverId || '');
      formData.append('status', isPrivate ? 'invalid' : 'valid');
      
      console.log('📤 Sending file upload with username:', username);

      try {
        await fetch(`${API_URL}/upload`, {
          method: 'POST',
          body: formData,
        });
        setInputText('');
        setSelectedFile(null);
        setFilePreview(null);
        setIsPrivate(false);
        setReceiverId('');
      } catch (error) {
        console.error('Error uploading file:', error);
      }
    } else if (inputText.trim() && ws) {
      ws.send(JSON.stringify({
        type: 'message',
        sender: username,
        text: inputText,
        private: isPrivate,
        receiver: isPrivate ? receiverId : undefined,
        status: isPrivate ? 'invalid' : 'valid'
      }));
      setInputText('');
      setIsPrivate(false);
      setReceiverId('');
    }
  };

  const handleFileSelect = (file) => {
    if (!file) return;
    
    setSelectedFile(file);
    
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setFilePreview(e.target.result);
      };
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }
  };

  const removeAttachment = () => {
    setSelectedFile(null);
    setFilePreview(null);
  };

  const toggleMessageStatus = async (msgId, currentStatus, viewerOnly = false) => {
    const newStatus = currentStatus === 'valid' ? 'invalid' : 'valid';
    try {
      const body = { status: newStatus };
      if (viewerOnly) body.viewer = username;

      await fetch(`${API_URL}/toggle_status/${msgId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (error) {
      console.error('Error toggling status:', error);
    }
  };

  const shouldBlur = (message) => {
    const isReceiver = message.private && message.receiver === username;
    const isSender = message.sender === username;
    
    if (isSender) {
      return false;
    }
    
    if (isReceiver && !validatingMessageId) {
      return true;
    }
    
    if (isReceiver && validatingMessageId) {
      if (message._id === validatingMessageId) {
        return temporaryInvalidMessages.has(message._id);
      }
      return true;
    }
    
    if (temporaryInvalidMessages.has(message._id)) {
      return true;
    }
    
    return message.status === 'invalid';
  };

  if (!isJoined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl shadow-2xl p-10 w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-800 mb-2">Privacy Chat</h1>
            <p className="text-gray-500">Join the conversation</p>
          </div>
          <div className="space-y-4">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleJoin()}
              placeholder="Enter your username"
              className="w-full px-5 py-4 text-lg border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition"
              autoFocus
            />
            <button
              onClick={handleJoin}
              className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-4 rounded-xl text-lg font-semibold hover:from-indigo-700 hover:to-purple-700 transition shadow-lg"
            >
              Join Chat
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-6 py-5 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Privacy Chat</h1>
            <p className="text-sm text-indigo-100">@{username}</p>
          </div>
        </div>
      </div>

      <video ref={videoRef} autoPlay muted style={{ display: 'none' }} />
      
      {validatingMessageId && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-black/80 text-white px-6 py-3 rounded-full shadow-lg flex items-center gap-3">
          <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
          <span className="font-medium">Camera Active</span>
          <span className="text-sm text-gray-300">{validationStatus}</span>
          <button 
            onClick={stopCamera}
            className="ml-2 text-red-400 hover:text-red-300 font-semibold"
          >
            Stop
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-6 max-w-4xl w-full mx-auto" onScroll={handleScroll}>
        <div className="space-y-4">
          {messages.map((msg) => {
            const isSender = msg.sender === username;
            if (msg.file_id) {
              console.log(`File message - sender: '${msg.sender}', username: '${username}', isSender: ${isSender}`);
            }
            const isReceiver = msg.private && msg.receiver === username;
            const blur = shouldBlur(msg);
            const isBeingValidated = validatingMessageId === msg._id;

            return (
              <div
                key={msg._id}
                className={`flex ${isSender ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-sm lg:max-w-md ${isSender ? 'items-end' : 'items-start'} w-full`}>
                  {!isSender && msg.sender && (
                    <div className="flex items-center gap-2 mb-2 px-2">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-400 flex items-center justify-center text-white font-semibold text-sm">
                        {msg.sender.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-sm text-gray-600 font-medium">{msg.sender}</span>
                    </div>
                  )}
                  
                  <div className="relative group">
                    <div
                      onClick={() => handlePrivateMessageClick(msg)}
                      className={`rounded-2xl px-5 py-3 shadow-md ${isReceiver && blur ? 'cursor-pointer hover:ring-2 hover:ring-purple-400' : ''} ${isBeingValidated ? 'ring-2 ring-green-400' : ''} ${
                        isSender
                          ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-br-sm'
                          : 'bg-white text-gray-800 rounded-bl-sm'
                      }`}
                      title={isReceiver && blur ? 'Click to verify and view' : ''}
                    >
                      {isReceiver && blur && !isBeingValidated && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="bg-purple-100 text-purple-700 px-3 py-1 rounded-full text-xs font-semibold">
                            👁️ Click to view
                          </div>
                        </div>
                      )}
                      
                      {msg.file_id && (
                        <div className={msg.text ? 'mb-2' : ''}>
                          {msg.content_type?.startsWith('image/') ? (
                            <div>
                              <img
                                src={`${API_URL}/file/${msg.file_id}?viewer=${username}`}
                                alt={msg.filename}
                                className={`rounded-xl max-w-full h-auto shadow-lg ${blur ? 'blur-lg' : ''}`}
                              />
                            </div>
                          ) : (
                            <a
                              href={`${API_URL}/file/${msg.file_id}?viewer=${username}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`flex items-center gap-2 text-sm hover:underline ${
                                isSender ? 'text-indigo-100' : 'text-indigo-600'
                              } ${blur ? 'blur-sm pointer-events-none' : ''}`}
                            >
                              <Paperclip className="w-4 h-4" />
                              {msg.filename}
                            </a>
                          )}
                        </div>
                      )}
                      
                      {msg.text && msg.text.trim() !== '' && (
                        <p className={`text-base leading-relaxed ${blur ? 'blur-md select-none' : ''} ${isSender ? 'text-white' : 'text-gray-800'}`}>
                          {msg.text}
                        </p>
                      )}
                      
                      {(isSender || isReceiver) && (
                        <button
                          onClick={() => toggleMessageStatus(msg._id, msg.status, isReceiver)}
                          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                          title={isSender ? 'Toggle visibility for everyone' : 'Toggle visibility for you'}
                          aria-label={isSender ? 'Toggle visibility for everyone' : 'Toggle visibility for you'}
                        >
                          {msg.status === 'valid' ? (
                            isSender ? (
                              <Unlock className="w-4 h-4 text-white/70 hover:text-white" />
                            ) : (
                              <Unlock className="w-4 h-4 text-indigo-600 hover:text-indigo-800" />
                            )
                          ) : (
                            isSender ? (
                              <Lock className="w-4 h-4 text-white/70 hover:text-white" />
                            ) : (
                              <Lock className="w-4 h-4 text-indigo-600 hover:text-indigo-800" />
                            )
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                  
                  <span className="text-xs text-gray-400 mt-1 block px-2">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="bg-white border-t border-gray-200 px-4 py-4 shadow-lg">
        <div className="max-w-4xl mx-auto">
          {selectedFile && (
            <div className="mb-3 px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start gap-3">
                {filePreview ? (
                  <img src={filePreview} alt="Preview" className="w-16 h-16 rounded-lg object-cover" />
                ) : (
                  <div className="w-16 h-16 bg-gray-200 rounded-lg flex items-center justify-center">
                    <Paperclip className="w-6 h-6 text-gray-500" />
                  </div>
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-700 truncate">{selectedFile.name}</p>
                  <p className="text-xs text-gray-500">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                </div>
                <button
                  onClick={removeAttachment}
                  className="text-red-500 hover:text-red-700 text-sm font-medium"
                >
                  Remove
                </button>
              </div>
            </div>
          )}
          
          {isPrivate && (
            <div className="mb-3 px-4 py-2 bg-purple-50 border border-purple-200 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-2 text-purple-700 text-sm">
                <Lock className="w-4 h-4" />
                <span>Private mode - message will be blurred for others</span>
              </div>
              <div className="flex items-center gap-3">
                <select
                  value={receiverId}
                  onChange={(e) => setReceiverId(e.target.value)}
                  className="px-3 py-1 text-sm border border-purple-200 rounded-md bg-white"
                >
                  <option value="">Select user</option>
                  {users.filter(u => u !== username).map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
                {users.filter(u => u !== username).length === 0 && (
                  <span className="text-xs text-purple-600">No other users online</span>
                )}
                <button 
                  onClick={() => { setIsPrivate(false); setReceiverId(''); }}
                  className="text-purple-700 hover:text-purple-900 text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          
          <div className="flex items-end gap-3">
            <input
              type="file"
              ref={fileInputRef}
              onChange={(e) => {
                handleFileSelect(e.target.files[0]);
                e.target.value = '';
              }}
              className="hidden"
            />
            
            <input
              type="file"
              ref={imageInputRef}
              accept="image/*"
              onChange={(e) => {
                handleFileSelect(e.target.files[0]);
                e.target.value = '';
              }}
              className="hidden"
            />
            
            <div className="flex gap-2">
              <button
                onClick={() => imageInputRef.current?.click()}
                className="p-3 text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition"
                title="Send image"
              >
                <Image className="w-5 h-5" />
              </button>
              
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-3 text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition"
                title="Send file"
              >
                <Paperclip className="w-5 h-5" />
              </button>
              
              <button
                onClick={() => {
                  const newVal = !isPrivate;
                  setIsPrivate(newVal);
                  if (!newVal) setReceiverId('');
                  else {
                    const others = users.filter(u => u !== username);
                    if (others.length === 1) setReceiverId(others[0]);
                  }
                }}
                className={`p-3 rounded-xl transition ${
                  isPrivate 
                    ? 'bg-purple-100 text-purple-600' 
                    : 'text-gray-500 hover:text-purple-600 hover:bg-purple-50'
                }`}
                title="Toggle private mode"
              >
                <Lock className="w-5 h-5" />
              </button>
            </div>
            
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder={selectedFile ? "Add a caption (optional)..." : "Type a message..."}
              className="flex-1 px-5 py-3 border-2 border-gray-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition text-base"
            />
            
            <button
              onClick={sendMessage}
              disabled={(!inputText.trim() && !selectedFile) || (isPrivate && !receiverId)}
              className="p-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-2xl hover:from-indigo-700 hover:to-purple-700 transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}