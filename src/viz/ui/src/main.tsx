import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { App } from './App.js';
import { MapRoute } from './MapRoute.js';
import { ReviewRoute } from './ReviewRoute.js';
import { RejectedRoute } from './RejectedRoute.js';
import { SequencesRoute } from './SequencesRoute.js';
import { ManualRoute } from './ManualRoute.js';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/map" element={<MapRoute />} />
        <Route path="/review" element={<ReviewRoute />} />
        <Route path="/sequences" element={<SequencesRoute />} />
        <Route path="/manual" element={<ManualRoute />} />
        <Route path="/rejected" element={<RejectedRoute />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
