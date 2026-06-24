import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Mic, MicOff, Headphones, Users, X, MessageSquare, Hand, Handshake } from 'lucide-react';
import './LiveSession.css';

const LiveSession = () => {
  const { roomId } = useParams();
  const [isMuted, setIsMuted] = useState(false);
  const [handRaised, setHandRaised] = useState(false);

  // Mock participants
  const participants = [
    { id: 1, name: 'Teacher Sarah', role: 'teacher', isSpeaking: true, isMuted: false },
    { id: 2, name: 'Alex Student', role: 'student', isSpeaking: false, isMuted: isMuted, isMe: true },
    { id: 3, name: 'Maria G.', role: 'student', isSpeaking: false, isMuted: true },
    { id: 4, name: 'Kenji T.', role: 'student', isSpeaking: false, isMuted: true },
  ];

  return (
    <div className="live-session-wrapper">
      <div className="live-session glass-panel">
        <header className="session-header">
          <div className="session-info">
            <span className="live-indicator">LIVE</span>
            <h2>Unit 7 Conversation Practice</h2>
            <span className="room-id">Room: {roomId || 'B2-U7-Room1'}</span>
          </div>
          <Link to="/courses/B2/7" className="btn-leave">
            <X size={20} />
            Leave Room
          </Link>
        </header>

        <div className="session-body">
          <div className="participants-grid">
            {participants.map(p => (
              <div key={p.id} className={`participant-card ${p.isSpeaking ? 'speaking' : ''}`}>
                <div className="participant-avatar">
                  {p.role === 'teacher' ? <Handshake size={32} /> : <Headphones size={32} />}
                  {(p.isMuted || (p.isMe && isMuted)) && (
                    <div className="muted-indicator">
                      <MicOff size={16} />
                    </div>
                  )}
                </div>
                <div className="participant-details">
                  <span className="participant-name">{p.name} {p.isMe && '(You)'}</span>
                  <span className="participant-role">{p.role}</span>
                </div>
                {p.isSpeaking && (
                  <div className="audio-waves">
                    <div className="wave"></div>
                    <div className="wave"></div>
                    <div className="wave"></div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="session-sidebar glass-panel">
            <div className="sidebar-header">
              <MessageSquare size={20} />
              <h3>Room Chat</h3>
            </div>
            <div className="chat-messages">
              <div className="message system">
                <span>Teacher Sarah started the session.</span>
              </div>
              <div className="message">
                <span className="sender teacher">Teacher Sarah:</span>
                <p>Welcome everyone! Let's start with a quick introduction.</p>
              </div>
              <div className="message">
                <span className="sender">Maria G.:</span>
                <p>Hello! I'm Maria from Spain.</p>
              </div>
            </div>
            <div className="chat-input-area">
              <input type="text" placeholder="Type a message..." className="chat-input" />
              <button className="btn-send">Send</button>
            </div>
          </div>
        </div>

        <footer className="session-controls">
          <button 
            className={`control-btn ${isMuted ? 'muted' : ''}`}
            onClick={() => setIsMuted(!isMuted)}
          >
            {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
            <span>{isMuted ? 'Unmute' : 'Mute'}</span>
          </button>

          <button 
            className={`control-btn ${handRaised ? 'active' : ''}`}
            onClick={() => setHandRaised(!handRaised)}
          >
            <Hand size={24} />
            <span>{handRaised ? 'Lower Hand' : 'Raise Hand'}</span>
          </button>

          <button className="control-btn">
            <Users size={24} />
            <span>Participants (4)</span>
          </button>
        </footer>
      </div>
    </div>
  );
};

export default LiveSession;
