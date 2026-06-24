import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, Pause, Video, CheckCircle, Headphones } from 'lucide-react';
import './UnitDetail.css';

const UnitDetail = () => {
  const { level, unitId } = useParams();
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState('reading');

  const togglePlay = () => setIsPlaying(!isPlaying);

  // Mock text for the reading assignment
  const readingText = `
    In today's fast-paced world, effective professional communication is more important than ever. 
    Whether you are writing an email, giving a presentation, or participating in a meeting, 
    the way you convey your ideas can significantly impact your career trajectory.
    
    One key aspect is clarity. Being clear and concise helps ensure that your message is understood 
    without ambiguity. It's often better to use simple, direct language rather than complex jargon 
    that might confuse your audience.
    
    Another critical component is active listening. Communication is a two-way street. 
    By truly listening to your colleagues and clients, you build trust and foster a collaborative 
    environment. This means paying attention, asking clarifying questions, and providing constructive feedback.
  `;

  return (
    <div className="unit-detail page-transition">
      <header className="unit-header">
        <Link to="/courses" className="back-btn">
          <ArrowLeft size={20} />
          Back to Courses
        </Link>
        <div className="unit-title-area">
          <span className={`badge-${level?.toLowerCase()} badge-large`}>{level} Unit {unitId}</span>
          <h1>Professional Communication</h1>
        </div>
      </header>

      <div className="unit-layout">
        <div className="main-column">
          <div className="content-tabs glass-panel">
            <button className={`tab ${activeTab === 'reading' ? 'active' : ''}`} onClick={() => setActiveTab('reading')}>
              <BookOpenIcon /> Reading & Audio
            </button>
            <button className={`tab ${activeTab === 'vocab' ? 'active' : ''}`} onClick={() => setActiveTab('vocab')}>
              <CheckCircle size={18} /> Vocabulary
            </button>
          </div>

          <div className="reading-content glass-panel">
            <div className="audio-player">
              <button className="play-pause-btn" onClick={togglePlay}>
                {isPlaying ? <Pause size={24} /> : <Play size={24} fill="currentColor" />}
              </button>
              <div className="audio-info">
                <h4>Listen to the text</h4>
                <p>AI-generated natural voice</p>
              </div>
              <div className="audio-progress">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: isPlaying ? '45%' : '0%' }}></div>
                </div>
                <span className="time">0:00 / 2:15</span>
              </div>
            </div>

            <div className="text-body">
              {readingText.split('\n').map((paragraph, idx) => (
                <p key={idx}>{paragraph}</p>
              ))}
            </div>
          </div>
        </div>

        <div className="sidebar-column">
          <div className="live-session-card glass-panel">
            <div className="card-icon">
              <Video size={32} color="var(--accent-color)" />
            </div>
            <h3>Live Conversation</h3>
            <p>Practice what you've learned with a teacher and other students in a live audio room.</p>
            
            <div className="session-info">
              <div className="info-row">
                <span>Status:</span>
                <span className="status-live">Live Now</span>
              </div>
              <div className="info-row">
                <span>Participants:</span>
                <span>3 / 4</span>
              </div>
            </div>

            <Link to={`/live/${level}-${unitId}`} className="btn-primary full-width">
              <Headphones size={20} />
              Join Audio Session
            </Link>
          </div>

          <div className="progress-card glass-panel">
            <h3>Unit Progress</h3>
            <ul className="checklist">
              <li className="completed"><CheckCircle size={16} /> Reading Material</li>
              <li className="completed"><CheckCircle size={16} /> Vocabulary Quiz</li>
              <li className="pending"><div className="circle-empty"></div> Live Session (50% of grade)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

const BookOpenIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
  </svg>
);

export default UnitDetail;
