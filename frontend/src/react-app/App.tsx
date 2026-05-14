import { BrowserRouter as Router, Routes, Route } from "react-router";
import { ErrorBoundary } from "@/react-app/components/ErrorBoundary";
import HomePage from "@/react-app/pages/Home";

export default function App() {
  return (
    <ErrorBoundary>
      <Router>
        <Routes>
          <Route path="/" element={<HomePage />} />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}
