## UX copy review: Sheetah

| Element | Before | After | Why |
|---|---|---|---|
| Engine status (loading) | Starting the engine… | Loading the engine (about 8 MB, once)… | Sets expectations on a slow connection |
| Engine status (ready) | Engine ready · offline-capable | Engine ready · runs on this device | "Offline" wasn't fully true (Parquet/JSON load once) |
| Drop zone title | Drop a file to open it | Drop a file, or click to browse | The whole card is clickable; say so |
| Drop zone formats | … any size your memory allows | CSV, TSV, JSON or Parquet · compressed .gz works too | Concrete, no vague limit |
| Demo note | Generated in your browser. No download. | Generated right here in a second. No file needed. | "No download" clashed with the 8 MB engine |
| File error | Couldn't open that file. {raw} | Couldn't open that file. Check that it's CSV, TSV, JSON or Parquet. {raw} | What happened + how to fix |
| Status hint | 3 sentences | Click a column name to sort, filter or profile it. Drag across cells to see their sum and average. | Two actions, each with its payoff |
| Toolbar | Column / CSV / Parquet | Add column / CSV / Parquet (+ tooltips) | Verb-first CTA; tooltips explain the export formats |
| Toast | Saved N rows as CSV | Downloaded N rows as CSV | Matches what the browser does |
| Top bar | Local only | Runs on this device | Same phrase as the landing page |
| Filter option | is empty | is empty (NULL) | Bridges spreadsheet and SQL vocabulary; the grid shows NULL |

Voice: plain, confident, short. Data terms where users expect them (rows, columns, SQL, NULL), no engine jargon in primary copy.
