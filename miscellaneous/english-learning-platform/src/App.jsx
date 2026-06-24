import React from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { BookOpen, Headphones, LayoutDashboard, Settings, Video } from 'lucide-react';
import './App.css';

// Layout Component
const Layout = ({ children }) => {
  const location = useLocation();
  
  return (
    <div className="app-layout">
      <nav className="sidebar glass-panel">
        <div className="logo-container">
          <div className="logo-icon">
            <Headphones size={24} color="var(--accent-color)" />
          </div>
          <h2 className="text-gradient">LingoFluent</h2>
        </div>
        
        <div className="nav-links">
          <Link to="/" className={`nav-link ${location.pathname === '/' ? 'active' : ''}`}>
            <LayoutDashboard size={20} />
            <span>Dashboard</span>
          </Link>
          <Link to="/courses" className={`nav-link ${location.pathname.startsWith('/courses') ? 'active' : ''}`}>
            <BookOpen size={20} />
            <span>Courses</span>
          </Link>
          <Link to="/live" className={`nav-link ${location.pathname.startsWith('/live') ? 'active' : ''}`}>
            <Video size={20} />
            <span>Live Sessions</span>
          </Link>
        </div>
        
        <div className="nav-footer">
          <Link to="/settings" className="nav-link">
            <Settings size={20} />
            <span>Settings</span>
          </Link>
          <div className="user-profile">
            <div className="avatar">A</div>
            <div className="user-info">
              <span className="user-name">Alex Student</span>
              <span className="user-level">B2 Level</span>
            </div>
          </div>
        </div>
      </nav>
      
      <main className="main-content">
        {children}
      </main>
    </div>
  );
};

// Placeholder Pages
import Dashboard from './pages/Dashboard';
import CourseMap from './pages/CourseMap';
import UnitDetail from './pages/UnitDetail';
import LiveSession from './pages/LiveSession';

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/courses" element={<CourseMap />} />
          <Route path="/courses/:level/:unitId" element={<UnitDetail />} />
          <Route path="/live/:roomId" element={<LiveSession />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
