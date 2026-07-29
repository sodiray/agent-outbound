import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { App } from './App.js';
import { MapRoute } from './MapRoute.js';
import { ReviewRoute } from './ReviewRoute.js';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/map" element={<MapRoute />} />
        <Route path="/review" element={<ReviewRoute />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
