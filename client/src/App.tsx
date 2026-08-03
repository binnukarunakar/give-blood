// Route table + shell. The router itself is mounted by the caller (main.tsx in
// the browser, MemoryRouter in tests) so routing can be driven from anywhere.
import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { AlertDetailPage } from './pages/AlertDetail';
import { DonorHome } from './pages/DonorHome';
import { Login } from './pages/Login';
import { RequestDetailPage } from './pages/RequestDetail';
import { RequesterHome } from './pages/RequesterHome';

export default function App(): ReactElement {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/donor" replace />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/donor"
          element={
            <RequireAuth>
              <DonorHome />
            </RequireAuth>
          }
        />
        <Route
          path="/requester"
          element={
            <RequireAuth>
              <RequesterHome />
            </RequireAuth>
          }
        />
        <Route
          path="/requester/requests/:requestId"
          element={
            <RequireAuth>
              <RequestDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/alerts/:alertId"
          element={
            <RequireAuth>
              <AlertDetailPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<p className="status">That page does not exist.</p>} />
      </Routes>
    </Layout>
  );
}
