import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { ReviewList } from './ReviewList';
import { RevealPage } from './RevealPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

// The gateway serves this page under /review, so the router uses that as its basename.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/review">
        <Routes>
          <Route index element={<ReviewList />} />
          <Route path="reveal/:id" element={<RevealPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
