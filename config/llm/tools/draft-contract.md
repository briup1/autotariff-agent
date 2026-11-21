Declare what this document means: fields, route handling and checks. Pass a JSON string shaped like
{"version":"v1","fields":[{"name":"起运港","role":"text","aliases":["起运港"],"required":true}],"route":{"kind":"columns","separators":["-"]},"checks":[{"id":"port-required","kind":"required_fields","params":{"fields":["起运港"]},"quote":"每条必须有起运港"}]}.
role is one of text, code, price, date, enum; aliases are the exact header words from the source.
check kinds: required_fields, price_preserved, enum, pattern, route_split, join_order, unique_source_ids, date_normalize, source_coverage.
Every check must quote the requirement text it enforces; use status "unchecked" with a reason when it cannot be checked.
The host validates the structure and re-scans the source before extraction, so a wrong contract shows up immediately.
When no requirements file exists, this contract is the observed proposal a person must confirm.
