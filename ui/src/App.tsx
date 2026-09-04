import { NavLink, Route, Routes } from "react-router-dom";
import RollsPage from "./pages/RollsPage";
import RollPage from "./pages/RollPage";
import JobsDrawer from "./components/JobsDrawer";
import ToastHost from "./components/ToastHost/ToastHost";

/**
 * Two screens and a drawer. The list of rolls, one roll — frames, takes, the
 * assembled episode and its acceptance report — and a drawer with whatever the
 * engine is doing right now. Everything the screens show is a file in the
 * workspace; the drawer is the only place with state of its own, and it holds
 * nothing that survives a reload.
 */
export default function App() {
  return (
    <div className="fl-app">
      <header className="fl-header">
        <NavLink to="/" className="fl-brand" end>
          {/* The mark is optional: without the file the wordmark stands alone
              instead of a broken-image icon. */}
          <img
            src="/firstlight.png"
            alt=""
            className="fl-brand__mark"
            onError={(e) => {
              e.currentTarget.hidden = true;
            }}
          />
          <span className="fl-brand__name">Firstlight</span>
        </NavLink>
        <span className="fl-header__tagline">the first frame, and everything after it</span>
      </header>
      <main className="fl-main">
        <Routes>
          <Route path="/" element={<RollsPage />} />
          <Route path="/roll/:id" element={<RollPage />} />
        </Routes>
      </main>
      <JobsDrawer />
      <ToastHost />
    </div>
  );
}
