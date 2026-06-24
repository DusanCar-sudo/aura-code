import React from 'react';
import { BookOpen, CheckCircle, Clock, PlayCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import './Dashboard.css';

const Dashboard = () => {
  // Mock data for the dashboard
  const progress = {
    completedUnits: 18,
    totalUnits: 36,
    liveSessionsAttended: 9,
    liveSessionsRequired: 18,
    currentLevel: 'B2',
    nextClass: 'Today, 18:00 PM'
  };

  const percentComplete = Math.round((progress.completedUnits / progress.totalUnits) * 100);
  const livePercent = Math.round((progress.liveSessionsAttended / progress.liveSessionsRequired) * 100);

  return (
    <div className="dashboard page-transition">
      <header className="dashboard-header">
        <div>
          <h1 className="text-gradient">Welcome back, Alex!</h1>
          <p className="subtitle">You're making great progress. Keep it up!</p>
        </div>
        <Link to={`/live/b2-room`} className="btn-primary">
          <PlayCircle size={20} />
          Join Next Class
        </Link>
      </header>

      <div className="stats-grid">
        <div className="stat-card glass-panel">
          <div className="stat-icon b1-bg">
            <BookOpen size={24} color="white" />
          </div>
          <div className="stat-info">
            <h3>Overall Progress</h3>
            <div className="progress-bar-container">
              <div className="progress-bar b1-bg" style={{ width: `${percentComplete}%` }}></div>
            </div>
            <p>{progress.completedUnits} / {progress.totalUnits} Units ({percentComplete}%)</p>
          </div>
        </div>

        <div className="stat-card glass-panel">
          <div className="stat-icon b2-bg">
            <CheckCircle size={24} color="white" />
          </div>
          <div className="stat-info">
            <h3>Live Session Attendance</h3>
            <div className="progress-bar-container">
              <div className="progress-bar b2-bg" style={{ width: `${livePercent}%` }}></div>
            </div>
            <p>{progress.liveSessionsAttended} / {progress.liveSessionsRequired} Required ({livePercent}%)</p>
          </div>
        </div>
      </div>

      <div className="dashboard-content">
        <div className="recent-units glass-panel">
          <h2>Continue Learning</h2>
          <div className="unit-list">
            <div className="unit-item">
              <div className="unit-level badge-b2">B2</div>
              <div className="unit-details">
                <h4>Unit 7: Professional Communication</h4>
                <p>Reading & Vocabulary</p>
              </div>
              <Link to="/courses/B2/7" className="btn-secondary">Resume</Link>
            </div>
            <div className="unit-item locked">
              <div className="unit-level badge-b2">B2</div>
              <div className="unit-details">
                <h4>Unit 8: Advanced Negotiations</h4>
                <p>Locked - Complete Unit 7</p>
              </div>
            </div>
          </div>
        </div>

        <div className="upcoming-schedule glass-panel">
          <h2>Upcoming Schedule</h2>
          <div className="schedule-item">
            <div className="schedule-time">
              <Clock size={16} />
              <span>18:00 - 19:00</span>
            </div>
            <div className="schedule-details">
              <h4>Conversation Practice</h4>
              <p>Topic: Technology in the Workplace</p>
            </div>
          </div>
          <div className="schedule-item">
            <div className="schedule-time">
              <Clock size={16} />
              <span>Tomorrow, 17:00</span>
            </div>
            <div className="schedule-details">
              <h4>Grammar Focus</h4>
              <p>Topic: Mixed Conditionals</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
