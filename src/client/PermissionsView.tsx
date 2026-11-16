/**
 * What the assistant may do. A placeholder until spec 1.2 step 4 builds the
 * full screen; that work replaces this file.
 */
export function PermissionsView({ onEdit }: { onEdit: () => void }) {
  return (
    <main className="main-content">
      <div className="page-heading">
        <div>
          <h1>What it may do</h1>
          <p>
            This screen will show what OpenDots does on its own, what it asks
            you first, and what it never does.
          </p>
        </div>
      </div>
      <p className="muted">
        Until then, each account’s tools and what they may do are in the{' '}
        <button className="text-button" onClick={onEdit}>
          assistant’s settings
        </button>
        .
      </p>
    </main>
  );
}
