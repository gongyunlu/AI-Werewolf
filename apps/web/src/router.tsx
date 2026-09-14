import { createBrowserRouter } from 'react-router-dom';
import HomePage from './pages/HomePage';
import GamesListPage from './pages/GamesListPage';
import GameWatchPage from './pages/GameWatchPage';
import AgentsPage from './pages/AgentsPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <HomePage />,
  },
  {
    path: '/agents',
    element: <AgentsPage />,
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
