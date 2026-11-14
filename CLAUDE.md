# Kwema Ride - Tanzania master (munezawasongah/kwema-ride-app)
Railway: API + PostGIS + Redis. Site: kwemaride.co.tz. Country repos: kwema-ride-kenya, -uganda, -rwanda.
## Fixed decisions (ask before changing)
- Tanzania is master: fix here first, then port. Every fix reply ends with "Port to: <countries>".
- Tiers: car, bajaji, bodaboda, XL/Express. Car pooling stays on branch feature/car-pooling.
- Delivery and Food are courier-only.
- Kiswahili default, English, French. Currency TZS.
- Testing phase: driver commission-debt blocking stays OFF.
## Important areas (Opus + self-review): dispatch/matching, payments, pricing, cross-country changes
## Core Rules
1. READ FIRST: before writing code, read the actual files and list their paths at the top of the reply. Missing file, value, price, date or fact -> write "Not found: <what>" and ask. Never guess. Ambiguous request -> ask up to 2 questions first.
2. ONE STEP: each reply has exactly ONE step, then stop and wait for my result. Commands are one self-contained PowerShell block (Windows 11) that starts with cd to the correct folder.
3. DONE WHEN: zero-error build/run command + 1-3 short test steps + end with the push-download block (merge newest zip from Downloads, commit, push).
4. SELF-REVIEW on the important areas listed below, or when I type REVIEW: no TODOs or placeholders, and end with a "Risks" section of exactly 3 items, each naming a file and how I'd notice it failing.
5. NEVER without my explicit yes: delete files or data, force-push, git init over an existing repo, run DB migrations, change secrets/env vars, or spend money.
6. MODEL: work on Sonnet. Tell me to switch to Opus only for the important areas below, then back.
7. Complete version first time: no basic version with "improve later". No praise, no recaps.
