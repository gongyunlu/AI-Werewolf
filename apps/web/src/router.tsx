import { createBrowserRouter } from 'react-router-dom';
import HomePage from './pages/HomePage';
import GamesListPage from './pages/GamesListPage';
import GameWatchPage from './pages/GameWatchPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <HomePage />,
  },
  {
    path: '/games',
    element: <GamesListPage />,
  },
  {
    path: '/games/:id',
    element: <GameWatchPage />,
  },
]);
