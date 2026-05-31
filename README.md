# Open Data Search — Backend

## Setup

```bash
cd backend
npm install
npm run dev       # development (nodemon)
npm start         # production
```

Runs on `http://localhost:4000`

## Endpoints

### `GET /api/search`
| Param | Type | Default | Description |
|---|---|---|---|
| `q` | string | required | Search query |
| `country` | string | `worldwide` | Filter zone: `worldwide`, `us`, `eu`, `global`, `ca`, `au`, `in` |
| `limit` | number | `10` | Results per page |

**Example:**
```
GET /api/search?q=climate+change&country=worldwide&limit=10
```

### `GET /api/sources`
Returns list of available country/region sources.

## Adding New Sources

1. Write a `fetchXYZ(query, limit)` function that returns raw API data
2. Add a `normalize("xyz", item)` case that maps to the common schema
3. Add `xyz: [fetchXYZ]` to the `SOURCES` map

## Common Schema
```js
{
  id, title, description,
  source, sourceFlag, country,
  tags[], formats[],
  url, updatedAt, organization
}
```

## Deployment (Railway / Render)
- Set `PORT` env var (or defaults to 4000)
- No other env vars required (all APIs used are public/free)
