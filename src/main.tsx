import '@mantine/core/styles.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import Application from './Application';
import { ApplicationProvider } from './data/application';
import './styles.css';
import './styles/features.css';
import { AppearanceProvider } from './theme/AppearanceProvider';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <ApplicationProvider>
        <Application />
      </ApplicationProvider>
    </AppearanceProvider>
  </React.StrictMode>,
);
