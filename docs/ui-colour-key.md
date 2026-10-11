# Colour key

Colour in the dashboard always means something, and it means the same thing on every page. There are five status colours and one interactive colour. Nothing else is coloured.

| Colour | Tone       | Meaning                                                                             |
| ------ | ---------- | ----------------------------------------------------------------------------------- |
| Red    | `critical` | Broken now, needs action                                                            |
| Amber  | `warning`  | Degraded: working, but slower or less reliable than it should be                    |
| Green  | `healthy`  | Working, or a problem that has been resolved                                        |
| Violet | `dq`       | Something is wrong with the **data**, not with the system                           |
| Grey   | `neutral`  | Unknown, or information without a judgement                                         |
| Teal   | accent     | Interactive only: links, primary buttons, selected tab, focus ring. Never a status. |

The colour key is also available in the app: the **Colour key** button at the right of the navigation bar.

## Every value and its colour

| Where                    | Value                                                        | Colour                                            |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| Alert severity           | Critical                                                     | Red                                               |
|                          | Warning                                                      | Amber                                             |
| Refresh status           | Success                                                      | Green                                             |
|                          | Failed                                                       | Red                                               |
|                          | Timed out                                                    | Amber                                             |
|                          | Unknown                                                      | Grey                                              |
| Load time (number)       | above 30 s                                                   | Red                                               |
|                          | above 15 s, up to 30 s                                       | Amber                                             |
|                          | 15 s or less                                                 | not coloured                                      |
| Health flags             | Refresh failed                                               | Red                                               |
|                          | Refresh timed out                                            | Amber                                             |
|                          | High latency                                                 | Amber (red when the load time is above 30 s)      |
|                          | Refresh unknown                                              | Grey                                              |
| Data-quality flags       | Orphaned / No owner                                          | Violet                                            |
|                          | Negative credits, Negative metric, No views                  | Violet                                            |
| Credits (number)         | negative                                                     | Violet                                            |
| Cost vs usage mismatches | High cost low usage, Low cost high usage, Cost with no views | Violet                                            |
| Alert status             | Open                                                         | Dark outline                                      |
|                          | Acknowledged                                                 | Grey outline (with who acknowledged it)           |
|                          | Resolved                                                     | Green outline                                     |
| Breaches column          | "15 readings, reopened 4 times"                              | not coloured (it is a count, not a judgement)     |
| Report panel (Overview)  | Broken / Degraded / Unknown / Healthy                        | Red / Amber / Grey / Green; violet dot = no owner |
| Live activity (Alerts)   | New critical / New warning                                   | Red / Amber                                       |
|                          | Escalated, Reopened                                          | Amber                                             |
|                          | Resolved                                                     | Green                                             |
|                          | Acknowledged                                                 | Grey                                              |
| Connection dot           | Live / Reconnecting / Offline                                | Green / Amber / Red                               |

## Badge grammar

- **Filled badge** = a judgement about severity or state (severity, refresh status, flags).
- **Outlined badge** = where an alert is in its lifecycle (open, acknowledged, resolved), so it never competes with the filled severity badge next to it.
- **Coloured number** = only when the number crosses a threshold (load time) or is impossible (negative credits).
- A row never shows two different colours for the same problem: a "Refresh failed" flag on a timed-out reading is shown as amber "Refresh timed out", matching the status badge.

## Where it lives in the code

- `client/src/theme/colourKey.js`: the single mapping from every value to a tone (`SEVERITY`, `REFRESH_STATUS`, `ALERT_STATUS`, `FLAGS`, `MISMATCH`, `loadTone`, `creditsTone`, `reportState`, `feedEventStyle`). Components ask this module for a tone and never choose a colour themselves.
- `client/src/styles.css`: the actual colour values, as CSS custom properties at the top of the file (`--critical-fg`, `--critical-bg`, ...), used through `.tone-*` classes.
- `client/src/components/ColourKeyDialog.jsx`: the in-app legend, generated from the same module.

To change a colour, edit the CSS token. To change what a value means, edit `colourKey.js`. Nothing else needs to change.
