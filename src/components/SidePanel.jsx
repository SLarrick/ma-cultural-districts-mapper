import { useRef, useState, useMemo, useEffect } from 'react'
import Papa from 'papaparse'
import * as turf from '@turf/turf'
import * as XLSX from 'xlsx'

let _nextRowId = 1
const newRow = (fields = {}) => ({
  id: _nextRowId++,
  name: '', address: '', city: '', state: 'MA', zip: '', type: '',
  lat: null, lng: null,
  status: 'pending', error: null,
  ...fields,
})

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

  // Reset ID counter when parent clears the list (e.g. muni switch)
  useEffect(() => {
    if (culturalAssets.length === 0) _nextRowId = 1
  }, [culturalAssets.length])

  const rows = culturalAssets
  const setRows = setCulturalAssets

  function updateRow(id, patch) {
    setRows(rows.map(r => r.id === id ? { ...r, ...patch, status: patch.lat != null ? r.status : 'pending' } : r))
  }

  function removeRow(id) {
    setRows(rows.filter(r => r.id !== id))
  }

  function addBlankRow() {
    setRows([...rows, newRow({ city: municipality?.name || '' })])
  }

  const districtAreaSqMi = useMemo(() => {
    if (!boundaryLayer || !boundaryLayer.geometry) return null
    try {
      const areaSqM = turf.area(boundaryLayer)
      return (areaSqM / 2589988.11).toFixed(2)
    } catch {
      return null
    }
  }, [boundaryLayer])

  const assetsInBoundary = useMemo(() => {
    if (!boundaryLayer || !boundaryLayer.geometry) return 0
    let count = 0
    for (const asset of rows) {
      if (asset.lat == null || asset.lng == null) continue
      try {
        const pt = turf.point([asset.lng, asset.lat])
        if (turf.booleanPointInPolygon(pt, boundaryLayer)) count++
      } catch { /* skip */ }
    }
    return count
  }, [boundaryLayer, rows])

  const geocodedCount = rows.filter(r => r.lat != null && r.lng != null).length
  const failedCount = rows.filter(r => r.status === 'failed').length
  const outOfMuniCount = rows.filter(r => r.status === 'out_of_muni').length

  function buildFullAddress(r) {
    let a = (r.address || '').trim()
    if (r.city) a += `, ${r.city}`
    if (r.state) a += `, ${r.state}`
    if (r.zip) a += ` ${r.zip}`
    return a.trim()
  }

  async function geocodeAddress(fullAddress) {
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
    } catch { /* fall through */ }
    try {
      const resp = await fetch(
        `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encoded}&benchmark=Public_AR_Current&format=json`
      )
      if (resp.ok) {
        const data = await resp.json()
        const match = data?.result?.addressMatches?.[0]
        if (match) return { lat: match.coordinates.y, lng: match.coordinates.x }
      }
    } catch { /* both failed */ }
    return null
  }

  const muniBbox = useMemo(() => {
    if (!parcelsData?.features?.length) return null
    try { return turf.bbox(parcelsData) } catch { return null }
  }, [parcelsData])

  function classify(coords) {
    if (!coords) return { status: 'failed' }
    if (muniBbox) {
      const [minLng, minLat, maxLng, maxLat] = muniBbox
      if (coords.lng < minLng || coords.lng > maxLng || coords.lat < minLat || coords.lat > maxLat) {
        return { status: 'out_of_muni' }
      }
    }
    return { status: 'geocoded' }
  }

  async function geocodeAllPending() {
    const pending = rows.filter(r => r.status === 'pending' || r.status === 'failed')
      .filter(r => buildFullAddress(r).length > 5)
    if (pending.length === 0) {
      setStatusMessage('Nothing to geocode — all rows already geocoded or empty')
      return
    }
    setGeocoding(true)
    let done = 0
    let workingRows = [...rows]
    for (const row of pending) {
      done++
      setStatusMessage(`Geocoding ${done}/${pending.length}: ${row.name || row.address}...`)
      const coords = await geocodeAddress(buildFullAddress(row))
      const { status } = classify(coords)
      workingRows = workingRows.map(r =>
        r.id === row.id
          ? { ...r, lat: coords?.lat ?? null, lng: coords?.lng ?? null, status, error: status === 'failed' ? 'No match' : null }
          : r
      )
      setRows(workingRows)
      if (done < pending.length) await new Promise(r => setTimeout(r, 1100))
    }

    // Auto-select parcels for successfully geocoded, in-muni assets
    if (parcelsData) {
      setSelectedParcels(prev => {
        const next = new Set(prev)
        for (const asset of workingRows) {
          if (asset.status !== 'geocoded') continue
          const pt = turf.point([asset.lng, asset.lat])
          for (const feature of parcelsData.features) {
            try {
              if (turf.booleanPointInPolygon(pt, feature)) {
                const id = feature.properties.LOC_ID || feature.properties.PROP_ID || feature.id
                if (id) next.add(id)
                break
              }
            } catch { /* skip */ }
          }
        }
        return next
      })
    }

    const okCount = workingRows.filter(r => r.status === 'geocoded').length
    const outCount = workingRows.filter(r => r.status === 'out_of_muni').length
    const failCount = workingRows.filter(r => r.status === 'failed').length
    const msg = [
      `${okCount} geocoded`,
      outCount > 0 ? `${outCount} outside ${municipality?.name || 'muni'}` : null,
      failCount > 0 ? `${failCount} failed` : null,
    ].filter(Boolean).join(', ')
    setStatusMessage(msg)
    setGeocoding(false)
  }

  function parseSpreadsheetRow(raw) {
    return newRow({
      name: raw['Asset Name'] || raw['Name'] || raw['name'] || '',
      address: raw['Street Address'] || raw['Address'] || raw['address'] || '',
      city: raw['City'] || raw['city'] || municipality?.name || '',
      state: raw['State'] || raw['state'] || 'MA',
      zip: raw['ZIP'] || raw['Zip'] || raw['zip'] || '',
      type: raw['Asset Type'] || raw['Type'] || raw['type'] || '',
    })
  }

  async function handleFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    let raws = []
    if (ext === 'xlsx' || ext === 'xls') {
      setStatusMessage('Reading spreadsheet...')
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array' })
      const sheetName = wb.SheetNames.find(n => !n.includes('DO NOT EDIT')) || wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]
      raws = XLSX.utils.sheet_to_json(ws, { defval: '' })
      raws.forEach(r => { if (r.ZIP != null) r.ZIP = String(r.ZIP).padStart(5, '0') })
    } else {
      setStatusMessage('Parsing file...')
      await new Promise((resolve) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => { raws = results.data; resolve() },
          error: (err) => { setStatusMessage('Error parsing file: ' + err.message); resolve() },
        })
      })
    }
    const parsed = raws.map(parseSpreadsheetRow).filter(r => r.name || r.address)
    setRows([...rows, ...parsed])
    setStatusMessage(`Added ${parsed.length} rows — click Geocode to place them on the map`)
    e.target.value = ''
  }

  // Paste TSV/CSV into the panel background → append as rows.
  // Pastes into individual inputs are left alone (target is INPUT).
  function handlePaste(e) {
    if (e.target.tagName === 'INPUT') return
    const text = e.clipboardData.getData('text')
    if (!text) return
    const lines = text.split(/\r?\n/).filter(l => l.trim())
    if (lines.length === 0) return
    const delim = lines[0].includes('\t') ? '\t' : ','
    if (!lines[0].includes(delim) && lines.length === 1) return
    e.preventDefault()

    const headerKeywords = ['name', 'address', 'street', 'city', 'state', 'zip', 'type']
    const firstCells = lines[0].split(delim).map(c => c.trim().toLowerCase())
    const hasHeader = firstCells.some(c => headerKeywords.some(k => c.includes(k)))

    let dataLines = lines
    let headers = ['name', 'address', 'city', 'state', 'zip', 'type']
    if (hasHeader) {
      headers = firstCells.map(c => {
        if (c.includes('name')) return 'name'
        if (c.includes('address') || c.includes('street')) return 'address'
        if (c.includes('city')) return 'city'
        if (c.includes('state')) return 'state'
        if (c.includes('zip')) return 'zip'
        if (c.includes('type')) return 'type'
        return null
      })
      dataLines = lines.slice(1)
    }

    const parsed = dataLines.map(line => {
      const cells = line.split(delim).map(c => c.trim().replace(/^"|"$/g, ''))
      const rec = { city: municipality?.name || '', state: 'MA' }
      cells.forEach((val, i) => {
        const key = headers[i]
        if (key) rec[key] = val
      })
      return newRow(rec)
    }).filter(r => r.name || r.address)

    if (parsed.length > 0) {
      setRows([...rows, ...parsed])
      setStatusMessage(`Pasted ${parsed.length} rows — click Geocode to place them on the map`)
    }
  }

  const isWide = municipality && (rows.length > 0)

  return (
    <div className={`side-panel ${isWide ? 'wide' : ''}`} onPaste={handlePaste}>
      <h3>Selection Info</h3>
      <div className="stat">
        <span>Selected Parcels</span>
        <strong>{selectedCount}</strong>
      </div>
      <div className="stat">
        <span>Cultural Assets</span>
        <strong>
          {geocodedCount}
          {rows.length > geocodedCount && <span style={{ color: '#888', fontWeight: 400 }}> / {rows.length}</span>}
        </strong>
      </div>
      {districtAreaSqMi && (
        <div className="stat">
          <span>District Area</span>
          <strong>{districtAreaSqMi} sq mi</strong>
        </div>
      )}
      {boundaryLayer && geocodedCount > 0 && (
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
        <>
          <div className="assets-header">
            <h3 style={{ marginBottom: 0 }}>Cultural Assets</h3>
            <div className="assets-actions">
              <button className="btn-mini" onClick={addBlankRow} disabled={geocoding} title="Add empty row">+ Row</button>
              <button className="btn-mini" onClick={() => fileRef.current?.click()} disabled={geocoding} title="Upload .xlsx / .csv">Upload…</button>
              <button
                className="btn-mini primary"
                onClick={geocodeAllPending}
                disabled={geocoding || rows.filter(r => r.status === 'pending' || r.status === 'failed').length === 0}
                title="Geocode pending & failed rows"
              >
                {geocoding ? 'Geocoding…' : 'Geocode'}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
              disabled={geocoding}
            />
          </div>

          {rows.length === 0 && (
            <div style={{ fontSize: 11, color: '#888', marginTop: 6, padding: '8px 4px' }}>
              Click <strong>+ Row</strong> to type an asset, <strong>Upload…</strong> for a spreadsheet, or paste tab-separated data from Excel/Sheets.
            </div>
          )}

          {rows.length > 0 && (
            <div className="asset-table">
              {(outOfMuniCount > 0 || failedCount > 0) && (
                <div className="assets-summary">
                  {outOfMuniCount > 0 && <span style={{ color: '#b91c1c' }}>⚠ {outOfMuniCount} outside {municipality.name}</span>}
                  {outOfMuniCount > 0 && failedCount > 0 && <span> · </span>}
                  {failedCount > 0 && <span style={{ color: '#b91c1c' }}>✗ {failedCount} failed to geocode</span>}
                </div>
              )}
              {rows.map(row => (
                <AssetRow key={row.id} row={row} onChange={updateRow} onRemove={removeRow} disabled={geocoding} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function AssetRow({ row, onChange, onRemove, disabled }) {
  const statusInfo = {
    pending: { icon: '○', color: '#9ca3af', title: 'Not geocoded yet' },
    geocoded: { icon: '●', color: '#059669', title: 'Geocoded' },
    out_of_muni: { icon: '⚠', color: '#b91c1c', title: 'Geocoded, but outside selected municipality' },
    failed: { icon: '✗', color: '#b91c1c', title: row.error || 'Geocode failed' },
  }[row.status] || { icon: '○', color: '#9ca3af', title: '' }

  return (
    <div className={`asset-row ${row.status === 'out_of_muni' || row.status === 'failed' ? 'flagged' : ''}`}>
      <div className="asset-row-line">
        <input
          className="asset-input name"
          value={row.name}
          onChange={(e) => onChange(row.id, { name: e.target.value })}
          placeholder="Asset name"
          disabled={disabled}
        />
        <span className="asset-status" style={{ color: statusInfo.color }} title={statusInfo.title}>{statusInfo.icon}</span>
        <button className="asset-remove" onClick={() => onRemove(row.id)} disabled={disabled} title="Remove">×</button>
      </div>
      <div className="asset-row-line">
        <input
          className="asset-input addr"
          value={row.address}
          onChange={(e) => onChange(row.id, { address: e.target.value })}
          placeholder="Street address"
          disabled={disabled}
        />
      </div>
      <div className="asset-row-line">
        <input
          className="asset-input city"
          value={row.city}
          onChange={(e) => onChange(row.id, { city: e.target.value })}
          placeholder="City"
          disabled={disabled}
        />
        <input
          className="asset-input zip"
          value={row.zip}
          onChange={(e) => onChange(row.id, { zip: e.target.value })}
          placeholder="ZIP"
          disabled={disabled}
        />
        <input
          className="asset-input type"
          value={row.type}
          onChange={(e) => onChange(row.id, { type: e.target.value })}
          placeholder="Type"
          disabled={disabled}
        />
      </div>
      {row.status === 'failed' && (
        <div className="asset-error">{row.error || 'Geocode failed'}</div>
      )}
    </div>
  )
}
