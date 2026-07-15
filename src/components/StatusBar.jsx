export default function StatusBar({ message, loading, hoveredParcel }) {
  return (
    <div className="status-bar">
      {loading && <div className="spinner" />}
      <span className="status-message">{message}</span>
      {hoveredParcel && (
        <span className="parcel-info">
          {hoveredParcel.addr && <span>{hoveredParcel.addr}</span>}
          {hoveredParcel.owner && <span className="parcel-owner"> — {hoveredParcel.owner}</span>}
        </span>
      )}
    </div>
  )
}
