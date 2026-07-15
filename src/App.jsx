import { useState, useCallback, useEffect, useRef } from 'react'
import MapView from './components/MapView'
import Toolbar from './components/Toolbar'
import SidePanel from './components/SidePanel'
import StatusBar from './components/StatusBar'
import 'leaflet/dist/leaflet.css'

function App() {
  const [municipality, setMunicipality] = useState(null)
  const [selectedParcels, setSelectedParcels] = useState(new Set())
  const [parcelsData, setParcelsData] = useState(null)
  const [culturalAssets, setCulturalAssets] = useState([])
  const [boundaryLayer, setBoundaryLayer] = useState(null)
  const [editingBoundary, setEditingBoundary] = useState(false)
  const [baseLayer, setBaseLayer] = useState('simple')
  const [loading, setLoading] = useState(false)
  const [statusMessage, setStatusMessage] = useState('Select a municipality to get started')
  const [hoveredParcel, setHoveredParcel] = useState(null)
  const [layerVisibility, setLayerVisibility] = useState({
    selectedLots: false,
    assets: false,
    boundary: false,
    parcelBoundaries: true,
    historicDistricts: false,
    historicResources: false,
  })

  // Track previous data states to detect empty → non-empty transitions
  const prevDataRef = useRef({ parcels: 0, assets: 0, boundary: false })

  // Auto-toggle layers on when their content first appears
  useEffect(() => {
    const prev = prevDataRef.current
    const updates = {}
    if (selectedParcels.size > 0 && prev.parcels === 0) updates.selectedLots = true
    if (culturalAssets.length > 0 && prev.assets === 0) updates.assets = true
    if (boundaryLayer && !prev.boundary) updates.boundary = true
    prevDataRef.current = { parcels: selectedParcels.size, assets: culturalAssets.length, boundary: !!boundaryLayer }
    if (Object.keys(updates).length > 0) {
      setLayerVisibility(v => ({ ...v, ...updates }))
    }
  }, [selectedParcels.size, culturalAssets.length, boundaryLayer])

  const handleParcelClick = useCallback((parcelId) => {
    setSelectedParcels(prev => {
      const next = new Set(prev)
      if (next.has(parcelId)) {
        next.delete(parcelId)
      } else {
        next.add(parcelId)
      }
      return next
    })
  }, [])

  const handleClearSelection = useCallback(() => {
    setSelectedParcels(new Set())
    setBoundaryLayer(null)
    setEditingBoundary(false)
    setCulturalAssets([])
    setStatusMessage('Selection cleared')
  }, [])

  const handleMunicipalityChange = useCallback((newMuni) => {
    if (!newMuni || newMuni.name === municipality?.name) return
    const hasWork = selectedParcels.size > 0 || culturalAssets.length > 0 || boundaryLayer
    if (hasWork) {
      const ok = window.confirm(
        `Switching to ${newMuni.name} will clear your parcel selection, cultural assets, and district boundary. Continue?`
      )
      if (!ok) return
      setSelectedParcels(new Set())
      setCulturalAssets([])
      setBoundaryLayer(null)
      setEditingBoundary(false)
    }
    setMunicipality(newMuni)
    setStatusMessage(`Loading ${newMuni.name}…`)
  }, [municipality, selectedParcels, culturalAssets, boundaryLayer])

  return (
    <div className="app">
      <Toolbar
        municipality={municipality}
        onMunicipalityChange={handleMunicipalityChange}
        selectedCount={selectedParcels.size}
        onClearSelection={handleClearSelection}
        parcelsData={parcelsData}
        selectedParcels={selectedParcels}
        setBoundaryLayer={setBoundaryLayer}
        setStatusMessage={setStatusMessage}
        boundaryLayer={boundaryLayer}
        editingBoundary={editingBoundary}
        setEditingBoundary={setEditingBoundary}
      />
      <div className="map-container">
        <MapView
          municipality={municipality}
          selectedParcels={selectedParcels}
          onParcelClick={handleParcelClick}
          parcelsData={parcelsData}
          setParcelsData={setParcelsData}
          culturalAssets={culturalAssets}
          boundaryLayer={boundaryLayer}
          setBoundaryLayer={setBoundaryLayer}
          editingBoundary={editingBoundary}
          baseLayer={baseLayer}
          setLoading={setLoading}
          setStatusMessage={setStatusMessage}
          setSelectedParcels={setSelectedParcels}
          setHoveredParcel={setHoveredParcel}
          layerVisibility={layerVisibility}
        />
        <SidePanel
          selectedCount={selectedParcels.size}
          culturalAssets={culturalAssets}
          setCulturalAssets={setCulturalAssets}
          setSelectedParcels={setSelectedParcels}
          parcelsData={parcelsData}
          setStatusMessage={setStatusMessage}
          municipality={municipality}
          boundaryLayer={boundaryLayer}
        />
        <div className="layer-visibility-panel">
          <div className="layer-visibility-title">District Layers</div>
          {[
            { key: 'selectedLots', label: 'Selected Lots', color: '#e94560' },
            { key: 'assets', label: 'Cultural Assets', color: '#f59e0b' },
            { key: 'boundary', label: 'District Boundary', color: '#8b5cf6' },
          ].map(({ key, label, color }) => (
            <label key={key} className="layer-checkbox">
              <input
                type="checkbox"
                checked={layerVisibility[key]}
                onChange={() => {
                  // Guard: if toggling ON with no content, show instructions
                  if (!layerVisibility[key]) {
                    if (key === 'selectedLots' && selectedParcels.size === 0) {
                      setStatusMessage('Select lots by clicking parcels on the map, or use the "+\u2B21" lasso tool to draw a shape around parcels to include in a cultural district.')
                      return
                    }
                    if (key === 'assets' && culturalAssets.length === 0) {
                      // Trigger the file upload dialog
                      const fileInput = document.querySelector('.upload-area input[type="file"]')
                      if (fileInput) {
                        fileInput.click()
                      } else {
                        setStatusMessage('Upload a cultural assets spreadsheet (.xlsx or .csv) using the panel on the right to display this layer.')
                      }
                      return
                    }
                    if (key === 'boundary' && !boundaryLayer) {
                      setStatusMessage('After selecting parcels to include in the district, click "Create Boundary" in the toolbar to generate a district boundary for this layer.')
                      return
                    }
                  }
                  setLayerVisibility(prev => ({ ...prev, [key]: !prev[key] }))
                }}
              />
              <span className="layer-swatch" style={{ background: color }} />
              {label}
            </label>
          ))}
          <div className="layer-divider" />
          <div className="layer-visibility-title">Reference</div>
          {[
            { key: 'parcelBoundaries', label: 'Parcel Boundaries', color: '#3388ff' },
            { key: 'historicDistricts', label: 'Historic Districts (MACRIS)', color: '#059669' },
            { key: 'historicResources', label: 'Historic Resources (MACRIS)', color: '#d4a574' },
          ].map(({ key, label, color }) => (
            <label key={key} className="layer-checkbox">
              <input
                type="checkbox"
                checked={layerVisibility[key]}
                onChange={() => setLayerVisibility(prev => ({ ...prev, [key]: !prev[key] }))}
              />
              <span className="layer-swatch" style={{ background: color }} />
              {label}
            </label>
          ))}
        </div>
        <div className="layer-toggle">
          {['streets', 'satellite', 'simple'].map(layer => (
            <button
              key={layer}
              className={baseLayer === layer ? 'active' : ''}
              onClick={() => setBaseLayer(layer)}
            >
              {layer.charAt(0).toUpperCase() + layer.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <StatusBar message={statusMessage} loading={loading} hoveredParcel={hoveredParcel} />
    </div>
  )
}

export default App
