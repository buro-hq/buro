import '@mantine/core/styles.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ProjectProvider } from './data/provider';
import './styles.css';
import { AppearanceProvider } from './theme/AppearanceProvider';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <ProjectProvider>
        <App />
      </ProjectProvider>
    </AppearanceProvider>
  </React.StrictMode>,
);
