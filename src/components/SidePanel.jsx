import { useRef, useState, useMemo } from 'react'
import Papa from 'papaparse'
import * as turf from '@turf/turf'
import * as XLSX from 'xlsx'

export default function SidePanel({
  selectedCount,
  culturalAssets,
  setCulturalAssets,
  setSelectedParcels,
  parcelsData,
  setStatusMessage,
  municipality,
  boundaryLayer,
}) {
  const fileRef = useRef()
  const [geocoding, setGeocoding] = useState(false)

  // Compute district area in square miles
  const districtAreaSqMi = useMemo(() => {
    if (!boundaryLayer || !boundaryLayer.geometry) return null
    try {
      const areaSqM = turf.area(boundaryLayer) // returns square meters
      return (areaSqM / 2589988.11).toFixed(2) // convert to sq miles
    } catch {
      return null
    }
  }, [boundaryLayer])

  // Count cultural assets inside the boundary
  const assetsInBoundary = useMemo(() => {
    if (!boundaryLayer || !boundaryLayer.geometry || culturalAssets.length === 0) return 0
    let count = 0
    for (const asset of culturalAssets) {
      try {
        const pt = turf.point([asset.lng, asset.lat])
        if (turf.booleanPointInPolygon(pt, boundaryLayer)) {
          count++
        }
      } catch { /* skip */ }
    }
    return count
  }, [boundaryLayer, culturalAssets])

  function parseRow(row) {
    // Support both the MCC template headers and common alternatives
    const name = row['Asset Name'] || row['Name'] || row['name'] || ''
    const streetAddr = row['Street Address'] || row['Address'] || row['address'] || ''
    const city = row['City'] || row['city'] || municipality?.name || ''
    const state = row['State'] || row['state'] || 'MA'
    const zip = row['ZIP'] || row['Zip'] || row['zip'] || ''
    const type = row['Asset Type'] || row['Type'] || row['type'] || ''

    // Build full address from components
    let fullAddress = streetAddr
    if (city) fullAddress += `, ${city}`
    if (state) fullAddress += `, ${state}`
    if (zip) fullAddress += ` ${zip}`

    return { name, address: streetAddr, fullAddress: fullAddress.trim(), type, city, state, zip }
  }

  async function geocodeAddress(fullAddress) {
    // Try Nominatim (OpenStreetMap) - more reliable than Census geocoder for CORS
    const encoded = encodeURIComponent(fullAddress)
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=us`,
        { headers: { 'Accept': 'application/json' } }
      )
      if (resp.ok) {
        const data = await resp.json()
        if (data && data.length > 0) {
          return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
        }
      }
    } catch {
      // Fall through to Census geocoder
    }

    // Fallback: Census geocoder
    try {
      const resp = await fetch(
        `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encoded}&benchmark=Public_AR_Current&format=json`
      )
      if (resp.ok) {
        const data = await resp.json()
        const match = data?.result?.addressMatches?.[0]
        if (match) {
          return { lat: match.coordinates.y, lng: match.coordinates.x }
        }
      }
    } catch {
      // Both failed
    }

    return null
  }

  async function processRows(rows) {
    setGeocoding(true)
    const parsed = rows.map(parseRow).filter(r => r.fullAddress.length > 5)
    setStatusMessage(`Geocoding ${parsed.length} addresses...`)
    const assets = []
    let failed = 0

    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i]
      setStatusMessage(`Geocoding ${i + 1}/${parsed.length}: ${row.name || row.address}...`)

      const coords = await geocodeAddress(row.fullAddress)
      if (coords) {
        assets.push({
          name: row.name,
          type: row.type,
          address: row.address,
          city: row.city,
          lat: coords.lat,
          lng: coords.lng,
        })
      } else {
        failed++
      }

      // Rate limit: Nominatim requests 1 req/sec
      if (i < parsed.length - 1) {
        await new Promise(r => setTimeout(r, 1100))
      }
    }

    setCulturalAssets(assets)
    const msg = `Geocoded ${assets.length} of ${parsed.length} addresses`
    setStatusMessage(failed > 0 ? `${msg} (${failed} failed)` : msg)

    // Select parcels that contain asset points
    if (parcelsData && assets.length > 0) {
      setSelectedParcels(prev => {
        const next = new Set(prev)
        for (const asset of assets) {
          const pt = turf.point([asset.lng, asset.lat])
          for (const feature of parcelsData.features) {
            try {
              if (turf.booleanPointInPolygon(pt, feature)) {
                const id = feature.properties.LOC_ID || feature.properties.PROP_ID || feature.id
                if (id) next.add(id)
                break
              }
            } catch {
              // Skip invalid geometries
            }
          }
        }
        return next
      })
      setStatusMessage(`${assets.length} assets geocoded, matching parcels selected`)
    }
    setGeocoding(false)
  }

  async function handleFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return

    const ext = file.name.split('.').pop().toLowerCase()

    if (ext === 'xlsx' || ext === 'xls') {
      // Read Excel file
      setStatusMessage('Reading spreadsheet...')
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array' })
      // Use first sheet (skip "Asset Types" reference sheet)
      const sheetName = wb.SheetNames.find(n => !n.includes('DO NOT EDIT')) || wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
      // Convert ZIP to string in case it was parsed as number
      rows.forEach(r => {
        if (r.ZIP != null) r.ZIP = String(r.ZIP).padStart(5, '0')
      })
      await processRows(rows)
    } else {
      // CSV/TSV
      setStatusMessage('Parsing CSV...')
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: async (results) => {
          await processRows(results.data)
        },
        error: (err) => {
          setStatusMessage('Error parsing file: ' + err.message)
        },
      })
    }

    // Reset file input so user can re-upload
    e.target.value = ''
  }

  return (
    <div className="side-panel">
      <h3>Selection Info</h3>
      <div className="stat">
        <span>Selected Parcels</span>
        <strong>{selectedCount}</strong>
      </div>
      <div className="stat">
        <span>Cultural Assets</span>
        <strong>{culturalAssets.length}</strong>
      </div>
      {districtAreaSqMi && (
        <div className="stat">
          <span>District Area</span>
          <strong>{districtAreaSqMi} sq mi</strong>
        </div>
      )}
      {boundaryLayer && culturalAssets.length > 0 && (
        <div className="stat">
          <span>Assets in District</span>
          <strong>{assetsInBoundary}</strong>
        </div>
      )}

      {!municipality && (
        <div className="upload-area" style={{ opacity: 0.6, cursor: 'default' }}>
          <p style={{ fontSize: 12, color: '#666', margin: 0 }}>
            Select a municipality above to add cultural assets.
          </p>
        </div>
      )}

      {municipality && (
        <div
          className="upload-area"
          onClick={() => !geocoding && fileRef.current?.click()}
          style={geocoding ? { opacity: 0.5, cursor: 'wait' } : {}}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            onChange={handleFileUpload}
            disabled={geocoding}
          />
          {geocoding ? (
            <p style={{ color: '#e94560' }}>Geocoding in progress...</p>
          ) : (
            <>
              <p>Upload cultural assets</p>
              <p style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                .xlsx or .csv with columns:<br/>
                Asset Name, Street Address, City, State, ZIP, Asset Type
              </p>
            </>
          )}
        </div>
      )}

      {culturalAssets.length > 0 && (
        <div className="asset-list">
          <h3 style={{ marginTop: 12 }}>Cultural Assets</h3>
          {culturalAssets.map((asset, i) => (
            <div key={i} className="asset-item">
              <div className="name">{asset.name}</div>
              <div className="address">{asset.address}{asset.city ? `, ${asset.city}` : ''}</div>
              {asset.type && <div style={{ color: '#666', fontSize: 11 }}>{asset.type}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
