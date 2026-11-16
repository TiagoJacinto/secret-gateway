import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { ReviewList } from './ReviewList';
import { RevealPage } from './RevealPage';

const reveal = window.location.pathname.match(/^\/review\/reveal\/([0-9a-f]{64})$/);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {reveal ? <RevealPage id={reveal[1]} /> : <ReviewList />}
  </StrictMode>,
);
