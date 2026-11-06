# Adverse Media Search Portal

A small local web app. You type a subject name, it runs two Google searches built from your keyword lists, shows the results with the matched keywords highlighted, and exports the results you keep to a PDF.

## How the queries are built

Your brief has two AND-groups, so the app runs two queries per search:

1. `"Subject" ("money laundering" OR terrorist OR "tax evasion" OR trafficking OR drug OR arms OR smuggling OR weapon OR nuclear OR crime OR arrest OR corrupt OR bribe OR embezzlement OR illegal OR fraud OR scam OR Ponzi OR sanction)`
2. `"Subject" (Iran OR "North Korea" OR Cuba OR Syria OR Crimea OR Sevastopol OR Donetsk OR Luhansk OR Kherson OR Zaporizhzhia)`

Results from both queries are merged, de-duplicated by URL, and tagged with the category they came from. Results that name the subject in the title or snippet are listed first.

The term lists are at the top of `server.js` (`CRIME_TERMS`, `REGION_TERMS`) if you want to change them.

## Setup (one time)

You need a Google Cloud API key and a Programmable Search Engine ID. Google's Custom Search JSON API is the supported way to get Google results programmatically. Scraping google.com is against Google's terms.

1. **API key:** In [Google Cloud Console](https://console.cloud.google.com/), create a project, enable the **Custom Search API**, and create an API key under *APIs & Services > Credentials*.
2. **Search engine ID:** In the [Programmable Search Engine control panel](https://programmablesearchengine.google.com/), create a search engine. Turn on **Search the entire web**. Copy the **Search engine ID** (cx).
3. Copy `.env.example` to `.env` and paste both values in.
4. Install and start:

```bash
npm install
npm start
```

5. Open http://localhost:3000

## Usage

1. Type the subject's name (for example `XXXXXXXXX`) and click **Search**.
2. Untick any results that are not relevant.
3. Click **Export selected to PDF**. The PDF downloads with the title, link, date, snippet and matched terms for each kept result.

## Limits to know about

- **Quota:** the free tier allows 100 queries per day. Each page of 10 results is one query. A search with 30 results per query costs 6 queries (3 pages x 2 queries). Beyond the free tier, Google charges per 1,000 queries.
- **Result cap:** the API returns at most 100 results per query, so the "100" option is the maximum.
- **Coverage:** results come from the Programmable Search index, which may differ from what you see on google.com. Check the query boxes shown in the app against the Programmable Search "Test" page if results look off.
- **Boolean syntax:** the Custom Search API does not support full Google boolean operators. The app sends `OR` and quoted phrases, and the results should be checked by a reviewer.
- **Name matching:** a name match in a search result is not proof of a match on the subject. A person reviews every hit before it goes into a report.

## Files

- `server.js`: Google search, query builder, PDF generation, and the HTTP server
- `public/index.html`: the search page
- `.env.example`: the settings you need to fill in
