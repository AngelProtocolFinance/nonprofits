# nonprofits

Look up any US tax-exempt organization by EIN or name: whether it's a 501(c)(3), whether gifts to it are tax-deductible, whether its exemption was revoked, plus its mission, top programs and finances from its latest Form 990. Every fact cites the IRS file it came from.

**https://nonprofits.better.giving**, over REST or MCP.

```sh
curl https://nonprofits.better.giving/v1/orgs/530196605
```

```json
{
  "ein": "530196605",
  "name": "AMERICAN NATIONAL RED CROSS",
  "address": { "street": "431 18TH ST NW", "city": "WASHINGTON", "state": "DC", "zip": "20006-5310" },
  "is501c3": true,
  "deductible": true,
  "revoked": false,
  ...
}
```

## Endpoints

### `GET /v1/orgs/{ein}`

One organization. `ein` is 9 digits, with or without the dash (`53-0196605`).

| Field | Meaning |
| --- | --- |
| `name`, `address` | As the IRS Business Master File lists them |
| `is501c3` | A 501(c)(3); `null` when the org isn't in the current Business Master File |
| `deductible` | Listed in IRS Publication 78, so gifts to it are tax-deductible |
| `revoked`, `revocationDate`, `reinstatementDate` | Exemption automatically revoked (and not reinstated since), with dates as `YYYY-MM-DD` |
| `mission`, `activitySummary`, `website` | From its latest e-filed Form 990 or 990-EZ |
| `programs` | Up to 3 program services, highest expense first |
| `finances` | `revenue`, `expenses`, `assets` (end of year) and `taxYear`, from its latest e-filed return |
| `notes` | Why a fact is `null` |
| `provenance` | For each fact, the IRS file it came from and when that file was released; for a filing fact, also the return (`objectId`, `taxYear`, `formType`) |

### `GET /v1/search?q={name}`

Organizations whose names contain every word of `q` (2 to 200 characters, up to 8 words), best match first. `limit` sets the page size: 10 by default, at most 50.

```sh
curl "https://nonprofits.better.giving/v1/search?q=red%20cross&limit=5"
```

Each result has `ein`, `name`, `city`, `state`, `is501c3`, `deductible` and their `provenance`. Look up an `ein` for the rest.

## MCP

`https://nonprofits.better.giving/mcp` serves the same data to AI assistants, as two tools: `lookup_nonprofit` (`ein`) and `search_nonprofits` (`query`, optional `limit`). In Claude Code:

```sh
claude mcp add --transport http nonprofits https://nonprofits.better.giving/mcp --header "Authorization: Bearer <key>"
```

Without the `--header`, it runs keyless on your own machine's limits. A hosted connector (claude.ai, ChatGPT and the like) calls from its provider's servers, where every user shares one address's keyless limits, so configure it with a key.

## API keys and limits

| | Per minute | Per day (UTC) |
| --- | --- | --- |
| No key | 1 | 5 |
| With a key | 10 | 50 |

Send a key as `Authorization: Bearer <key>`. Lookups, searches and MCP tool calls count alike. Requests refused for bad input, or while the service is unavailable, aren't counted.

To get a key, or higher limits, contact Better Giving.

## Errors

Errors are [problem details](https://www.rfc-editor.org/rfc/rfc9457) JSON with a `code` and a `detail` saying what to do. A 429 carries `Retry-After` in seconds.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_ein`, `invalid_query`, `invalid_limit` | Fix the request; `detail` says how |
| 401 | `invalid_api_key`, `revoked_api_key` | The key is wrong or revoked. A request with a bad key is never served keyless. |
| 404 | `not_found` | No organization with that EIN in the IRS files |
| 429 | `per_minute_limit_exceeded` | Wait `Retry-After` seconds |
| 429 | `daily_quota_exceeded` | Your daily limit is used up until UTC midnight |
| 429 | `service_daily_limit_reached` | The whole service is at its daily limit for your tier until UTC midnight |
| 503 | `data_unavailable`, `auth_unavailable` | Temporarily unavailable; retry later |

## The data

Rebuilt each month from the IRS's public bulk files: the Business Master File, Publication 78, the automatic revocation list, the 990-N e-Postcard list, and the Form 990, 990-EZ and 990-PF e-file releases from the last three years. Each organization's latest e-filed return is the one read. A field is `null` when the IRS files don't hold it, and `notes` says why.

This is IRS data as published, not tax advice. Before relying on deductibility, check [IRS Tax Exempt Organization Search](https://apps.irs.gov/app/eos/).

## Contributing

How it's built, tested, run and deployed: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). The IRS data is public.
