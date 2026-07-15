import { useMemo } from 'react'
import * as turf from '@turf/turf'
import { MUNICIPALITIES } from '../data/municipalities'

export default function Toolbar({
  municipality,
  onMunicipalityChange,
  selectedCount,
  onClearSelection,
  parcelsData,
  selectedParcels,
  setBoundaryLayer,
  setStatusMessage,
  boundaryLayer,
  editingBoundary,
  setEditingBoundary,
}) {

  const filtered = useMemo(() => MUNICIPALITIES, [])

  function handleMunicipalitySelect(e) {
    const name = e.target.value
    const muni = MUNICIPALITIES.find(m => m.name === name)
    if (muni) {
      onMunicipalityChange(muni)
    }
  }

  function handleCreateBoundary() {
    if (!parcelsData || selectedParcels.size === 0) return
    setStatusMessage('Generating district boundary...')

    // Use setTimeout so the UI updates before heavy computation
    setTimeout(() => {
      try {
        const selectedFeatures = parcelsData.features.filter(f =>
          selectedParcels.has(f.properties.LOC_ID || f.properties.PROP_ID || f.id)
        )
        if (selectedFeatures.length === 0) {
          setStatusMessage('No parcels selected')
          return
        }

        // Buffer 25m to bridge across streets (including triangular intersections),
        // then union, then negative buffer to contract back
        const BUFFER_KM = 0.025 // 25 meters in km
        let merged = null
        for (const feature of selectedFeatures) {
          const buffered = turf.buffer(feature, BUFFER_KM, { units: 'kilometers', steps: 2 })
          if (!buffered) continue
          if (!merged) {
            merged = buffered
          } else {
            try {
              merged = turf.union(turf.featureCollection([merged, buffered]))
            } catch {
              // If union fails on a single parcel, continue
            }
          }
        }
        if (merged) {
          // Contract back by the same buffer to restore approximate parcel edges
          let cleaned = turf.buffer(merged, -BUFFER_KM, { units: 'kilometers', steps: 2 })
          cleaned = cleaned || merged

          // Simplify geometry aggressively to reduce vertices and produce angular edges
          // Tolerance of ~0.0005 (~55m) flattens near-straight runs into single segments
          const simplified = turf.simplify(cleaned, { tolerance: 0.0005, highQuality: true })
          setBoundaryLayer(simplified || cleaned)
          setEditingBoundary(true)
          setStatusMessage(`Boundary created from ${selectedFeatures.length} parcels — drag vertices to edit, then export`)
        }
      } catch (err) {
        setStatusMessage('Error creating boundary: ' + err.message)
      }
    }, 50)
  }

  function handleFinishEditing() {
    setEditingBoundary(false)
    setStatusMessage('Boundary finalized. Export when ready.')
  }

  function handleCancelBoundary() {
    setBoundaryLayer(null)
    setEditingBoundary(false)
    setStatusMessage('Boundary removed')
  }

  function handleExport(format) {
    if (!boundaryLayer) return
    let content, filename, mimeType

    if (format === 'geojson') {
      content = JSON.stringify(boundaryLayer, null, 2)
      filename = `${municipality?.name || 'district'}_boundary.geojson`
      mimeType = 'application/json'
    } else if (format === 'kml') {
      content = geojsonToKml(boundaryLayer)
      filename = `${municipality?.name || 'district'}_boundary.kml`
      mimeType = 'application/vnd.google-earth.kml+xml'
    } else if (format === 'shp') {
      exportShapefile(boundaryLayer, municipality?.name || 'district')
      setStatusMessage('Exported as Shapefile (.zip)')
      return
    }

    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    setStatusMessage(`Exported as ${format.toUpperCase()}`)
  }

  return (
    <div className="toolbar">
      <h1>MA Cultural Districts Mapper</h1>
      <select value={municipality?.name || ''} onChange={handleMunicipalitySelect}>
        <option value="">Select Municipality...</option>
        {filtered.map(m => (
          <option key={m.name} value={m.name}>{m.name}</option>
        ))}
      </select>

      {/* Selection mode */}
      {!editingBoundary && selectedCount > 0 && (
        <>
          <div className="separator" />
          <span>{selectedCount} parcels selected</span>
          <button onClick={handleCreateBoundary}>Create Boundary</button>
          <button onClick={onClearSelection} style={{ background: '#555' }}>Clear</button>
        </>
      )}

      {/* Boundary editing mode */}
      {editingBoundary && boundaryLayer && (
        <>
          <div className="separator" />
          <span style={{ color: '#ff6b35' }}>Editing Boundary</span>
          <button onClick={handleFinishEditing} style={{ background: '#22c55e' }}>Done Editing</button>
          <button onClick={handleCancelBoundary} style={{ background: '#555' }}>Cancel</button>
        </>
      )}

      {/* Export (available when boundary exists and not editing) */}
      {boundaryLayer && !editingBoundary && (
        <>
          <div className="separator" />
          <button onClick={() => handleExport('geojson')}>Export GeoJSON</button>
          <button onClick={() => handleExport('kml')}>Export KML</button>
          <button onClick={() => handleExport('shp')}>Export SHP</button>
          <button onClick={() => setEditingBoundary(true)} style={{ background: '#ff6b35' }}>Edit Boundary</button>
        </>
      )}
    </div>
  )
}

function geojsonToKml(geojson) {
  const coords = geojson.geometry?.coordinates || []
  const type = geojson.geometry?.type

  function coordsToKml(ring) {
    return ring.map(c => `${c[0]},${c[1]},0`).join(' ')
  }

  let placemarks = ''
  if (type === 'Polygon') {
    placemarks = `<Placemark><name>District Boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coordsToKml(coords[0])}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`
  } else if (type === 'MultiPolygon') {
    placemarks = coords.map((poly, i) =>
      `<Placemark><name>District Boundary ${i + 1}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coordsToKml(poly[0])}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`
    ).join('\n')
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>Cultural District Boundary</name>
${placemarks}
</Document>
</kml>`
}

async function exportShapefile(geojson, name) {
  try {
    const shpwrite = await import('@mapbox/shp-write')
    const options = {
      folder: `${name}_boundary`,
      filename: `${name}_boundary`,
      outputType: 'blob',
      compression: 'DEFLATE',
    }
    // shp-write expects a FeatureCollection
    const fc = geojson.type === 'FeatureCollection'
      ? geojson
      : { type: 'FeatureCollection', features: [geojson] }

    const zipBlob = await shpwrite.zip(fc, options)
    const url = URL.createObjectURL(zipBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}_boundary.zip`
    a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    console.error('SHP export error:', err)
    // Fallback: download as GeoJSON if SHP fails
    const content = JSON.stringify(geojson, null, 2)
    const blob = new Blob([content], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}_boundary.geojson`
    a.click()
    URL.revokeObjectURL(url)
  }
}
