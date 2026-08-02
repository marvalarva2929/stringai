# DMCA / Copyright Notice Clause (draft — for Terms of Service)

Drop this section into the Terms of Service page at `stringai.app/terms`. Written
for the app as it works today: the "add a piece" flow lets a user pick a PDF
from their own device (`app/(tabs)/analyze.tsx`, `DocumentPicker`), but that
file is referenced by local URI only — StringAI does not currently upload or
host it on any server. If server-side storage of user-provided sheet music is
added later (the `pieces.pdf_storage_path` column already anticipates this),
this clause is what makes that storage covered by DMCA safe harbor, provided
you've also registered a designated agent — see plan item A10.

---

## Copyright Complaints (DMCA)

StringAI respects the intellectual property rights of others. If you believe
material accessible through the Service infringes your copyright, you may
submit a notice to our designated agent containing:

1. A physical or electronic signature of the copyright owner or a person
   authorized to act on their behalf.
2. Identification of the copyrighted work claimed to have been infringed.
3. Identification of the material claimed to be infringing, with enough
   detail that we can locate it.
4. Your contact information — address, telephone number, and email.
5. A statement that you have a good-faith belief that use of the material is
   not authorized by the copyright owner, its agent, or the law.
6. A statement, made under penalty of perjury, that the above information is
   accurate and that you are the copyright owner or authorized to act on
   their behalf.

Send notices to our designated DMCA agent at: **[fill in once registered —
see copyright.gov/dmca-directory]**, or by email to **[legal@stringai.app /
your chosen address]**.

A user who receives a valid counter-notification may have their content
restored after 10–14 business days unless the original complainant files a
court action. We reserve the right to terminate the accounts of users
determined to be repeat infringers.

---

## Notes for whoever fills this in

- Replace the bracketed agent contact info once you've registered with the
  U.S. Copyright Office ($6, renews every 3 years — copyright.gov/dmca-directory).
- The curated piece catalog (`src/services/imslp.ts`) only references
  public-domain works by composer/title — no infringement exposure there.
- If/when `pieces.pdf_storage_path` becomes a real upload target, make sure a
  takedown mechanism (e.g. deleting the row + storage object) actually exists
  before this clause goes live — a policy that isn't backed by a real
  mechanism doesn't help you.
