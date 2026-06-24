import React, { useState } from 'react';
import { Lock, Play, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import './CourseMap.css';

const CourseMap = () => {
  const [activeTab, setActiveTab] = useState('B2');

  const levels = [
    { id: 'B1', name: 'Intermediate', colorClass: 'b1-color' },
    { id: 'B2', name: 'Upper Intermediate', colorClass: 'b2-color' },
    { id: 'C1', name: 'Advanced', colorClass: 'c1-color' }
  ];

  // Generate 12 units for the map
  const renderUnits = (level) => {
    const units = [];
    for (let i = 1; i <= 12; i++) {
      let status = 'locked';
      if (level === 'B1') status = 'completed';
      if (level === 'B2' && i <= 6) status = 'completed';
      if (level === 'B2' && i === 7) status = 'current';
      
      units.push(
        <div key={i} className={`course-node ${status}`}>
          <div className="node-line"></div>
          <div className="node-circle glass-panel">
            {status === 'completed' && <Check size={20} />}
            {status === 'current' && <Play size={20} fill="currentColor" />}
            {status === 'locked' && <Lock size={20} />}
          </div>
          <div className="node-content glass-panel">
            <span className="unit-number">Unit {i}</span>
            <h4>{getUnitTitle(i)}</h4>
            {status !== 'locked' && (
              <Link to={`/courses/${level}/${i}`} className="btn-primary start-btn">
                {status === 'completed' ? 'Review' : 'Start Lesson'}
              </Link>
            )}
          </div>
        </div>
      );
    }
    return units;
  };

  const getUnitTitle = (index) => {
    const titles = [
      "Introductions & Small Talk", "Travel & Tourism", "Health & Lifestyle",
      "Work & Career", "Technology & Future", "Environment & Nature",
      "Professional Communication", "Advanced Negotiations", "Culture & Society",
      "Media & Entertainment", "Global Issues", "Final Assessment"
    ];
    return titles[index - 1] || `Unit ${index}`;
  };

  return (
    <div className="course-map page-transition">
      <header className="map-header">
        <h1>Course Map</h1>
        <p className="subtitle">Your journey to English fluency</p>
        
        <div className="level-tabs glass-panel">
          {levels.map(level => (
            <button 
              key={level.id}
              className={`level-tab ${activeTab === level.id ? 'active' : ''}`}
              onClick={() => setActiveTab(level.id)}
            >
              <span className={`tab-badge ${level.colorClass}`}>{level.id}</span>
              {level.name}
            </button>
          ))}
        </div>
      </header>

      <div className="map-path">
        {renderUnits(activeTab)}
      </div>
    </div>
  );
};

export default CourseMap;
