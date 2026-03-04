# NanoReview Unofficial API

Unofficial REST API for extracting structured device data, comparisons,
suggestions, and rankings from nanoreview.net using Playwright +
Fastify.

------------------------------------------------------------------------

## Features

-   Smart multi-type search (CPU, GPU, SoC, Phone, Laptop, Tablet)
-   Full device specifications extraction
-   Device-to-device comparison
-   Performance rankings (CPU / GPU / SoC)
-   Autocomplete suggestions
-   Cloudflare challenge handling
-   In-memory caching (5 min TTL)
-   Vercel-compatible deployment
-   MIT Licensed

------------------------------------------------------------------------

## Installation

``` bash
git clone https://github.com/yourusername/nanoreview-unofficial-api.git
cd nanoreview-unofficial-api
npm install
```

------------------------------------------------------------------------

## Run Locally

``` bash
npm start
```

Server runs on:

    http://localhost:3000

------------------------------------------------------------------------

# API Documentation

Base URL:

    http://localhost:3000/api

------------------------------------------------------------------------

## 1. Search Device

### Endpoint

    GET /api/search?q=<query>&index=<optional>

### Example

    http://localhost:3000/api/search?q=iphone 15

### Response Structure

``` json
{
  "success": true,
  "contentType": "device_details",
  "data": {
    "title": "Device Name",
    "sourceUrl": "https://nanoreview.net/...",
    "images": [],
    "scores": {},
    "pros": [],
    "cons": [],
    "specs": {},
    "matchedQuery": "query",
    "searchResults": []
  }
}
```

------------------------------------------------------------------------

## 2. Compare Devices

### Endpoint

    GET /api/compare?q1=<device1>&q2=<device2>

### Example

    http://localhost:3000/api/compare?q1=iphone 15&q2=galaxy s24

### Response Structure

``` json
{
  "success": true,
  "contentType": "comparison",
  "data": {
    "title": "Device 1 vs Device 2",
    "sourceUrl": "...",
    "images": [],
    "device1": {},
    "device2": {},
    "comparisons": {}
  }
}
```

------------------------------------------------------------------------

## 3. Suggestions

### Endpoint

    GET /api/suggestions?q=<query>

### Example

    http://localhost:3000/api/suggestions?q=iphone

------------------------------------------------------------------------

## 4. Rankings

### Endpoint

    GET /api/rankings?type=<type>

### Supported Types

-   desktop-cpu
-   laptop-cpu
-   mobile-soc
-   desktop-gpu
-   laptop-gpu

### Example

    http://localhost:3000/api/rankings?type=desktop-cpu

------------------------------------------------------------------------

## Error Response Format

``` json
{
  "success": false,
  "error": "Error message"
}
```

Status Codes:

-   400 → Invalid parameters
-   404 → Not found
-   500 → Internal server error

------------------------------------------------------------------------

## License

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files to deal in the
Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software.
