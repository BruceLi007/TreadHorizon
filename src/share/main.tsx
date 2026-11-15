import { createRoot } from 'react-dom/client';
import ErrorBoundary from '../ui/ErrorBoundary';
import '../styles.css';
import './share.css';
import ShareEntry from './ShareEntry';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ShareEntry />
  </ErrorBoundary>
);
