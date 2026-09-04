import { useEffect, useState } from "react";
import { api } from "../api";
import type { Workspace } from "../api";
import { humanError } from "../utils/humanText";

/**
 * What the workspace is, and what is in it right now.
 *
 * "Where do the files go" was the first question anybody asked, and the honest
 * answer is not a paragraph of prose but the folders themselves with their
 * counts. Everything Firstlight knows lives here; there is no database behind
 * the interface, so this page is the whole story.
 */
export default function WorkspacePage() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .workspace()
      .then(setWs)
      .catch((e) => setError(humanError(e)));
  }, []);

  if (error) return <p className="fl-error">{error}</p>;
  if (!ws) return <p className="fl-muted">Reading the workspace…</p>;

  const size = (b: number) =>
    b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(1)} GB` : b >= 1024 * 1024 ? `${Math.round(b / 1024 / 1024)} MB` : b > 0 ? `${Math.max(1, Math.round(b / 1024))} KB` : "—";

  return (
    <div className="fl-page">
      <div className="fl-page__head">
        <div>
          <h1 className="fl-h1">Workspace</h1>
          <p className="fl-muted">
            Everything Firstlight makes and reads lives in one folder. There is no database: what is
            on disk is the whole state, for the interface exactly as for the command line.
          </p>
        </div>
      </div>

      <p className="fl-muted fl-path">
        <code>{ws.root}</code> · settings in <code>{ws.config}</code>
      </p>

      <table className="fl-table">
        <thead>
          <tr>
            <th>Folder</th>
            <th>What is in it</th>
            <th className="fl-table__num">Files</th>
            <th className="fl-table__num">Size</th>
          </tr>
        </thead>
        <tbody>
          {ws.folders.map((f) => (
            <tr key={f.key}>
              <td>
                <code>{f.path}</code>
              </td>
              <td>{f.what}</td>
              <td className="fl-table__num">{f.files || "—"}</td>
              <td className="fl-table__num">{size(f.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="fl-note surface-card">
        <h2 className="fl-h2">How a roll goes through</h2>
        <ol className="fl-steps">
          <li>
            <b>Write the scenario.</b> New roll, then fill the scenes in on the Scenario tab: who is
            in the frame, which background, what it shows, what the narrator says. Saving writes the
            YAML and compiles it.
          </li>
          <li>
            <b>Keyframes.</b> Two frames per shot, generated from the scene description with the
            character reference sheets attached. Check them one at a time and reject what is wrong —
            a rejected frame moves to <code>_rejected/</code>, it is not deleted.
          </li>
          <li>
            <b>Motion.</b> Each accepted pair becomes a clip on a GPU. Without one, <b>Synthetic
            takes</b> makes stand-ins so the rest can be tried out.
          </li>
          <li>
            <b>Assemble.</b> Title card, captions, narration on their timecodes, one file.
          </li>
          <li>
            <b>Verify.</b> The written standard as a script: format, duration, loudness, every scene
            present, every caption visible. The result is a file, and this interface reads it.
          </li>
        </ol>
        <p className="fl-muted">
          Steps two and three need <code>GEMINI_API_KEY</code> and a ComfyUI host; the rest works
          with neither. The example series runs end to end without either.
        </p>
      </section>
    </div>
  );
}
