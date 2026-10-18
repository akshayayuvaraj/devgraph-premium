# Judge demo (about 3 minutes)
Setup once: `npm run init`, `npm run seed:demo`, `npm start`, open http://localhost:8080, **Open the app**, create the first (admin) account. The banner confirms the data is labelled demo.
1. **Overview**: live counts, the open incident INC-231, open tasks.
2. **Investigate**, ask: *What breaks if payment-service fails, who has worked on it, and what happened before?*
3. **Answer** (evidence-only mode works without any key): priority HIGH (score 11), downstream notification-service and checkout-service, four impacted projects, Marcus Cole as best-placed developer, documented fix from INC-201, linked history INC-208/214/219. Click a citation chip (E7) to jump to its evidence.
4. **Decision trace**: tools chosen from the question, readable queries, rows returned; evidence typed direct vs inferred.
5. **Uncertainty**: conflict (INC-225 resolved without a resolution) and gap (notification-service has no owner).
6. **Action**: proposed task for INC-231 assigned to Marcus Cole with its evidence. **Review and confirm**; the outcome is read back from the graph.
7. **Memory**: open the saved investigation; resolve INC-231 in Incidents, ask again: the answer reports the change, the old memory turns stale, and no action is proposed.
8. **Graph**: search, filter, highlighted evidence path. **Settings**: honest LLM status (admins can test the connection).
