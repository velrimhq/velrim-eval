# Natural absent-cell audit worksheet

One row per golden `missing` cell, all four classes, 142 cells total. The question per
cell: is a value for this field visibly in the document? `visible` means the label is wrong
and the cell is struck. `unverifiable` means the deciding region is illegible or redacted
and the cell is struck. `absent` means the label is confirmed and the cell stands.

Method: a text-layer search of the digital class (vrdu-ad-buy) came first. The scan classes
(cord-v2, deepform, vrdu-registration) were judged from 150dpi page renders, since their
text layers are empty or cover-sheet metadata only. Verdicts were drafted with model
assistance over the renders and maintainer-verified. Each verdict carries its evidence.
The audit ran before any competitor call, per Amendment 1 of the analysis plan. The strike record derived from this worksheet is
`natural-strikes.json`.

Result: 40 visible, 6 unverifiable, 96 absent-confirmed.

| class | doc | field | verdict | page | value seen | evidence | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cord-v2 | cord-011.pdf | /credit_card | absent | 1 |  |  | Tender section fully legible and cash-only, the one blurred line sits below CHANGE in the footer zone. |
| cord-v2 | cord-011.pdf | /discount | absent | 1 |  |  | No DISKON/DISCOUNT line in the legible totals block. |
| cord-v2 | cord-011.pdf | /service_charge | absent | 1 |  |  | No SERVICE/SVC line in the legible totals block. |
| cord-v2 | cord-011.pdf | /subtotal | absent | 1 |  |  | Money block complete and legible (item 230,000 / TOTAL / CASH / CHANGE) with no SUB TOTAL line. |
| cord-v2 | cord-011.pdf | /tax | absent | 1 |  |  | No PAJAK/PPN/TAX line anywhere between the item line and CHANGE. |
| cord-v2 | cord-015.pdf | /credit_card | absent | 1 |  |  | Tender lines are CASH 70.000 and CHANGED 7.000 only, no card line. |
| cord-v2 | cord-015.pdf | /discount | absent | 1 |  |  | No DISKON/DISCOUNT line on the receipt. |
| cord-v2 | cord-015.pdf | /service_charge | absent | 1 |  |  | No SERVICE/SVC line on the receipt. |
| cord-v2 | cord-015.pdf | /subtotal | absent | 1 |  |  | Items go straight to TOTAL 63.000, no SUBTOTAL line printed. |
| cord-v2 | cord-015.pdf | /tax | absent | 1 |  |  | No TAX/PAJAK/PPN line between the item block and CASH. |
| cord-v2 | cord-025.pdf | /credit_card | absent | 1 |  |  | Tender region legible and cash-only, blurred line is below CHANGE in the footer zone. |
| cord-v2 | cord-025.pdf | /discount | absent | 1 |  |  | No DISKON/DISCOUNT line printed. |
| cord-v2 | cord-025.pdf | /service_charge | absent | 1 |  |  | No SERVICE/SVC line printed. |
| cord-v2 | cord-025.pdf | /subtotal | absent | 1 |  |  | Three item lines then TOTAL 43,000 directly, no SUBTOTAL label. |
| cord-v2 | cord-025.pdf | /tax | absent | 1 |  |  | No TAX/PAJAK line in the legible totals block. |
| cord-v2 | cord-027.pdf | /change | absent | 1 |  |  | Totals block ends at TOTAL 61,600 / CHARGE5 61,600, no KEMBALI/CHANGE line. |
| cord-v2 | cord-027.pdf | /credit_card | absent | 1 |  | CHARGE5    61,600 | Only tender line reads CHARGE5, not identified as a card, flagged as a borderline unlabeled tender line. |
| cord-v2 | cord-027.pdf | /discount | absent | 1 |  |  | No DISKON/DISCOUNT line in the legible totals block. |
| cord-v2 | cord-027.pdf | /service_charge | absent | 1 |  | lines: items, SUBTOTAL, TAX 10%, TOTAL, CHARGE5 | No service-charge line, predicted '2.00%' is a mangled grab of '2.00 ITEMS', genuine fabrication at 0.94 confidence. |
| cord-v2 | cord-044.pdf | /credit_card | absent | 1 |  |  | Tender is CASH 88.000 / CHANGED 0, blurred footer is prose, not money lines. |
| cord-v2 | cord-044.pdf | /discount | absent | 1 |  |  | No DISKON/DISCOUNT line printed. |
| cord-v2 | cord-044.pdf | /service_charge | absent | 1 |  |  | No SERVICE/SVC line printed. |
| cord-v2 | cord-044.pdf | /subtotal | absent | 1 |  |  | Four item lines then TOTAL 88.000, no SUBTOTAL label. |
| cord-v2 | cord-044.pdf | /tax | absent | 1 |  |  | No TAX/PAJAK/PPN line printed. |
| cord-v2 | cord-047.pdf | /credit_card | unverifiable | 1 |  | redacted label+value line between Cash and CHANGE | Blurred line sits exactly where a card-tender line would print. |
| cord-v2 | cord-047.pdf | /discount | absent | 1 |  |  | '25%' under the item is a KOI drink sugar-level modifier, not a discount. |
| cord-v2 | cord-047.pdf | /service_charge | absent | 1 |  |  | Pre-total block is PB1 / Subtotal / Total, all legible, with no SERVICE line. |
| cord-v2 | cord-056.pdf | /cash | visible | 1 | 100,000 | 'CASH 100,000' and 'Pay: 100,000' | Printed cash-tendered line. |
| cord-v2 | cord-056.pdf | /credit_card | absent | 1 |  |  | Tender lines are CASH / Pay: / Change Due:, all cash. |
| cord-v2 | cord-056.pdf | /discount | absent | 1 |  |  | No DISKON/DISCOUNT line in the legible totals block. |
| cord-v2 | cord-056.pdf | /service_charge | absent | 1 |  |  | Totals block is Sub Total / PB1 / Total / Pay / Change Due, no SERVICE line. |
| cord-v2 | cord-066.pdf | /credit_card | absent | 1 |  |  | Tender is CASH .50,000 / CHANGE .30,000 only. |
| cord-v2 | cord-066.pdf | /discount | absent | 1 |  |  | No DISKON/DISCOUNT line printed. |
| cord-v2 | cord-066.pdf | /service_charge | absent | 1 |  |  | No SERVICE/SVC line printed. |
| cord-v2 | cord-066.pdf | /subtotal | absent | 1 |  |  | Single item then TOTAL directly, no SUBTOTAL label. |
| cord-v2 | cord-066.pdf | /tax | absent | 1 |  |  | No TAX/PAJAK/PB1 line among the four legible money lines. |
| cord-v2 | cord-068.pdf | /cash | absent | 1 |  |  | Bill ends at 'DU 1,565,938' with no payment/tender section, no TUNAI/CASH line printed. |
| cord-v2 | cord-068.pdf | /change | absent | 1 |  |  | No KEMBALI/CHANGE line anywhere, receipt stops at the amount-due line. |
| cord-v2 | cord-068.pdf | /credit_card | absent | 1 |  |  | No card/VISA/DEBIT tender line on the legible portion. |
| cord-v2 | cord-068.pdf | /discount | absent | 1 |  |  | Totals block is FOOD/BEVERAGES/OTHERS/SUBTOTAL/SERVICE CHARGE/Tax 10% only, no DISKON line. |
| cord-v2 | cord-073.pdf | /cash | absent | 1 |  |  | Pizza Hut slip ends at TOTAL 282,000 followed only by dashed separators, no tender line. |
| cord-v2 | cord-073.pdf | /change | absent | 1 |  |  | No CHANGE/KEMBALI line below TOTAL, marks under it are dashed separators, verified at 3x zoom. |
| cord-v2 | cord-073.pdf | /credit_card | absent | 1 |  |  | No card tender line printed on the visible slip. |
| cord-v2 | cord-073.pdf | /discount | absent | 1 |  |  | No DISKON/DISCOUNT line among the legible totals. |
| cord-v2 | cord-073.pdf | /service_charge | absent | 1 |  |  | Only SUBTOTAL and TAX appear between items and TOTAL. |
| cord-v2 | cord-076.pdf | /change | absent | 1 |  |  | Below 'Cash Tendered: 22.000' only a centred blurred footer greeting with no amount column. |
| cord-v2 | cord-076.pdf | /credit_card | absent | 1 |  |  | Payment is cash-tendered, no card tender line printed. |
| cord-v2 | cord-076.pdf | /discount | absent | 1 |  |  | No DISKON line, only zero-value row is the item '6001-Plastic Bag Small 0'. |
| cord-v2 | cord-076.pdf | /service_charge | absent | 1 |  |  | No SERVICE/SVC line in the totals block. |
| cord-v2 | cord-076.pdf | /subtotal | absent | 1 |  |  | Only 'Total. 22.000' and 'Total Item: 2' appear. |
| cord-v2 | cord-076.pdf | /tax | absent | 1 |  |  | No PAJAK/PPN/TAX line between the item block and the total. |
| cord-v2 | cord-084.pdf | /cash | absent | 1 |  |  | Tender is 'VISA 8945 47,000', no cash line printed. |
| cord-v2 | cord-084.pdf | /discount | absent | 1 |  |  | No DISCOUNT/DISKON row on the legible slip. |
| cord-v2 | cord-084.pdf | /service_charge | absent | 1 |  |  | No SERVICE/SVC row between SUB TOTAL and GRAND TOTAL. |
| cord-v2 | cord-084.pdf | /tax | absent | 1 |  |  | SUB TOTAL 47,000 -> GRAND TOTAL 47,000 with no tax row, blurred lines below CHANGE DUE are card/merchant text with no amount column. |
| cord-v2 | cord-086.pdf | /change | absent | 1 |  |  | Block ends 'CASH 29,500 / Total Item 1 / Total Qty 1', no change row (cash equals total). |
| cord-v2 | cord-086.pdf | /credit_card | absent | 1 |  |  | Tender line is CASH, no card tender printed. |
| cord-v2 | cord-086.pdf | /discount | absent | 1 |  |  | No DISKON row in the totals block. |
| cord-v2 | cord-086.pdf | /service_charge | absent | 1 |  |  | Only Subtotal, Pb1 (tax) and Total appear. |
| cord-v2 | cord-087.pdf | /credit_card | absent | 1 |  |  | Tender is 'CASH 30.000', no card line. |
| cord-v2 | cord-087.pdf | /discount | absent | 1 |  |  | No DISKON row among the legible lines. |
| cord-v2 | cord-087.pdf | /service_charge | absent | 1 |  |  | Warung-style slip has only TL/CASH/CG rows, no service line. |
| cord-v2 | cord-087.pdf | /subtotal | absent | 1 |  |  | Items go straight to 'TL 21,000', no subtotal line. |
| cord-v2 | cord-087.pdf | /tax | absent | 1 |  |  | No PAJAK/PPN/TAX line, TL equals the sum of the two items. |
| cord-v2 | cord-095.pdf | /service_charge | absent | 1 |  | 'BIAYA TAMBAHAN 0' (additional charges) | No SERVICE/SVC row, BIAYA TAMBAHAN (additional fee) is a different field, resolved from my earlier unclear by the cord vision agent. |
| cord-v2 | cord-095.pdf | /tax | visible | 1 | 6,818 | 'PAJAK PPN 10 % 6,818' | Indonesian VAT line. |
| deepform | deepform-50e20ed6-1232-4272-a28a-4632d68679fc.pdf | /contract_number | visible | 1 | 89015 (top edge clipped, last digit 3/5 ambiguous) | Contract # 890.. printed at top of page 1 | Golden says missing, number is visibly printed. |
| vrdu-ad-buy | 0189d309-8f8e-3064-d9fd-52009ba3d5cb.pdf | /tv_address | absent |  |  |  | Only address on doc is agency Waterfront Strategies' (AGY block), no WPBN station address. |
| vrdu-ad-buy | 030a8ffe-9abb-57ad-2e82-58312730c0f6.pdf | /agency | visible | 1 | Canal Partners Media / POL | Canal Partners Media / POL 900 Circle 75 Parkway SE Suite 1650 Atlanta, GA 30339 | Agency block, advertiser is separately POL/Teresa Tomlinson. |
| vrdu-ad-buy | 030f7df7-6d1d-b6c7-3a36-39edb0725603.pdf | /property | visible | 1 | WHP | Station:   WHP | Labelled Station on both pages. |
| vrdu-ad-buy | 0719de4c-5538-0fe8-123b-f0aca437b53d.pdf | /agency | visible | 1 | Grassroots Media LLC | Sara Gideon-US Senate  Grassroots Media LLC | Agency in advertiser/agency header pair. |
| vrdu-ad-buy | 07bfa311-9fc7-c3d2-4e7a-94d7fd412599.pdf | /tv_address | absent |  |  |  | Only address belongs to agency FP1 Strategies, no KMSB station address. |
| vrdu-ad-buy | 08fe4888-65a4-3254-b5d2-dad9186a9694.pdf | /agency | visible | 1 | Amplify Media | POL/AB PAC  Amplify Media | Agency of the WYOU invoice, Agency Commission line billed. |
| vrdu-ad-buy | 103ccc17-356a-5f99-9c3b-920fc2dd023e.pdf | /agency | visible | 1 | Adelstein and Associates | Citizens for P. Scott Neville Jr  Adelstein and Associates | Buying agency on the WPWR invoice. |
| vrdu-ad-buy | 15262fcf-40c4-1ee6-6719-6ae834d12a4e.pdf | /agency | visible | 1 | AL Media | AL Media 222 W. Ontario St. Suite 503 Chicago, IL 60610 | Agency block with own address. |
| vrdu-ad-buy | 15c06d79-8d29-0a6f-3edc-f57d54da3ea7.pdf | /agency | visible | 1 | Matrix LLC | POL/Alabama Nursing Home Association  Matrix LLC | Agency present, and the Agency Commission $645.00 line confirms one exists. |
| vrdu-ad-buy | 15c06d79-8d29-0a6f-3edc-f57d54da3ea7.pdf | /flight_from | visible | 1 | 03/31/20 | Order Flight Order # 2456509 03/31/20 - 04/03/20 | Start of labelled Order Flight range. |
| vrdu-ad-buy | 15c06d79-8d29-0a6f-3edc-f57d54da3ea7.pdf | /flight_to | visible | 1 | 04/03/20 | Order Flight Order # 2456509 03/31/20 - 04/03/20 | End of labelled Order Flight range. |
| vrdu-ad-buy | 15c06d79-8d29-0a6f-3edc-f57d54da3ea7.pdf | /product | absent |  |  |  | 'Product 1/2' is a preprinted form label, header holds only estimate number. |
| vrdu-ad-buy | 1672687e-ddc6-ce1d-8ab1-46acdc04953f.pdf | /flight_from | visible | 1 | 11/25/2019 | 11/25/2019 - 12/29/2019 | Sole schedule range, start matches first aired spot. |
| vrdu-ad-buy | 1672687e-ddc6-ce1d-8ab1-46acdc04953f.pdf | /flight_to | visible | 1 | 12/29/2019 | 11/25/2019 - 12/29/2019 | End of that range. |
| vrdu-ad-buy | 1a8e7b10-6823-dfdf-d398-0cd7740b9699.pdf | /agency | visible | 1 | Medium Buying LLC | Medium Buying LLC 1351 King Ave Uppr 2nd floor Columbus, OH | Agency block on the WLKY contract. |
| vrdu-ad-buy | 1af023e1-3d51-7fe6-f8f1-70656181f5f1.pdf | /agency | visible | 1 | Waterfront Strategies | Senate Majority PAC  Waterfront Strategies | Agency in header pair, advertiser is Senate Majority PAC. |
| vrdu-ad-buy | 1ddf64fb-65ba-f3db-eb89-8cb9a2802a5a.pdf | /agency | visible | 1 | Buying Time LLC | Buying Time LLC 650 Massachusetts Avenue NW Suite 210 | Agency block on the WYCW contract. |
| vrdu-ad-buy | 1ecc29f7-3929-b19e-1ac9-fc5be0688708.pdf | /agency | visible | 1 | Assembly | Billing Address: Assembly ... 711 3rd Avenue 3rd Floor New York | Billing block carries the agency in this invoice family (sibling 348812cb confirms). 'Millennium/Washington DC' on the page is the rep sales office, not an agency. |
| vrdu-ad-buy | 1ecc29f7-3929-b19e-1ac9-fc5be0688708.pdf | /flight_from | visible | 1 | 02/10/20 | Deal# [ 02/10/20 - 02/21/20 | Only date range, brackets all aired spots. |
| vrdu-ad-buy | 1ecc29f7-3929-b19e-1ac9-fc5be0688708.pdf | /flight_to | visible | 1 | 02/21/20 | Deal# [ 02/10/20 - 02/21/20 | End of range, matches last aired spot. |
| vrdu-ad-buy | 2093ee21-d0ee-3641-03b4-3025ae441836.pdf | /flight_to | visible | 1 | 06/09/20 | Flight Dates: ... 06/05/20 - 06/09/20 | End of labelled Flight Dates range. |
| vrdu-ad-buy | 2093ee21-d0ee-3641-03b4-3025ae441836.pdf | /tv_address | absent |  |  |  | '815 Slaters Lane' is agency National Media's address (AGY block), no WMBF station address. |
| vrdu-ad-buy | 2aac88c6-7849-4aa6-5315-5ceeabbdcf73.pdf | /agency | visible | 1 | Canal Partners Media LLC | Teresa Tomlinson for Senate  Canal Partners Media LLC | Agency in header pair, station WGCL. |
| vrdu-ad-buy | 348812cb-8af7-56bc-8a19-c3c4f6682392.pdf | /agency | visible | 1 | Assembly Media | Assembly Media 711 Third Ave 3rd Floor New York, NY 10017 | Agency block of the KDFI contract, 'Michael Bloomberg 2020, Inc' is the advertiser. |
| vrdu-ad-buy | 3874b015-8c4f-2a34-b461-ce049874dc07.pdf | /agency | visible | 1 | American Media and Advocacy Group | American Media and Advocacy Group 815 Slaters Ln Alexandria, VA | Agency block on the WYFF contract. |
| vrdu-ad-buy | 38f02241-0fda-abeb-bdf9-032f40279e89.pdf | /agency | visible | 1 | Canal Partners Media | Canal Partners Media 25 Witlock Place Suite 201 Marietta, GA | Agency block on the WVIR contract. |
| vrdu-registration | 19410222_DLA_Piper_US_LLP_Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | Government of the Republic of Turkey | Item 4: 'Exhibit B for the Government of the Republic of Turkey.' | Named twice in the narrative. |
| vrdu-registration | 19410222_DLA_Piper_US_LLP_Amendment_Amendment.pdf | /signer_name | visible | 2 | John Zentay | signature over typed 'John Zentay, Partner' | Typed name under the signature. |
| vrdu-registration | 19410222_DLA_Piper_US_LLP_Amendment_Amendment.pdf | /signer_title | visible | 2 | Partner | 'John Zentay, Partner' under signature line | Part of the printed name line, not a caption. |
| vrdu-registration | 19631101_Tourism_Australia_Amendment_Amendment.pdf | /file_date | visible | 1 | November 4, 1963 | Stamp: 'FILED / NOV 4 1963 / Registration Section / DOJ' | DOJ FILED stamp legible, sworn-line date illegible. |
| vrdu-registration | 19670801_JETRO,_San_Francisco_Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | Japan External Trade Organization, Tokyo | Item 5: 'Item 10  Japan External Trade Organization, Tokyo' | P2 confirms 'remittance from our foreign principal'. |
| vrdu-registration | 19670901_JETRO,_San_Francisco_Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | JETRO, Tokyo | Item 14(a): 'Remittances from JETRO, Tokyo' | 14(a) is receipts from the foreign principal. |
| vrdu-registration | 19710401_Netherlands_Board_of_Tourism_and_Conventions_(NBTC)_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Only registrant + a short-form deficiency named. |
| vrdu-registration | 19710401_Netherlands_Board_of_Tourism_and_Conventions_(NBTC)_Amendment_Amendment.pdf | /signer_name | unverifiable | 1 |  | illegible scrawl, no typed name | Box 1 types 'Mr. John G. Bertram' but nothing ties it to the signature. |
| vrdu-registration | 19710401_Netherlands_Board_of_Tourism_and_Conventions_(NBTC)_Amendment_Amendment.pdf | /signer_title | unverifiable | 1 |  | 'Director for North America' in registrant box only | Title visible but not attached to the signer. |
| vrdu-registration | 19711201_Tourism_Australia_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Only a western-region office address change. |
| vrdu-registration | 19760701_Tourism_Authority_of_Thailand,_New_York_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Publicity expense breakdown only. |
| vrdu-registration | 19770101_Representative_of_the_Turkish_Republic_of_Northern_Cyprus_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Address change + newspaper-letters narrative, no principal named. |
| vrdu-registration | 19770401_World_Zionist_Organization_-_American_Section,_Inc._Amendment_Amendment.pdf | /foreign_principal_name | visible | 2 | World Zionist Organization (W.Z.O.) | 'The foreign principal on whose behalf the Registrant functions ... is World Zionist Organization (W.Z.O.)' | Explicit statement on attached sheet. |
| vrdu-registration | 19770401_World_Zionist_Organization_-_American_Section,_Inc._Amendment_Amendment.pdf | /signer_title | absent | 1 |  | signature over typed 'Isadore Hamlin', no title | Only the notary has a title. |
| vrdu-registration | 19770501_Korea_National_Tourism_Organization,_New_Jersey_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Item 4 lists brochure titles, not a principal. |
| vrdu-registration | 19781201_Cayman_Islands_Department_of_Tourism_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Revised expenditure schedule only. |
| vrdu-registration | 19790101_IDA_Ireland_Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | Industrial Development Authority Ireland, Dublin Ireland | Item 5: 'Foreign Principal - Industrial Development Authority Ireland, Dublin Ireland.' | Literally labeled Foreign Principal on the form. |
| vrdu-registration | 19790101_Representative_of_the_Turkish_Republic_of_Northern_Cyprus_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Principal referenced ('my principal') but never named. |
| vrdu-registration | 19800101_Italian_Government_Travel_Office,_Chicago_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Names individuals and commissioner posts, not a principal org. |
| vrdu-registration | 19800101_Italian_Government_Travel_Office,_Chicago_Amendment_Amendment.pdf | /signer_title | absent | 1 |  | short scrawl, name/title lines blank | 'Notary or other officer' is the printed caption. |
| vrdu-registration | 19800301_Quebec_Government_Office_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Short-form statement item only. |
| vrdu-registration | 19820801_St._Lucia_Tourist_Board_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Item 5 is only '15(c) - No'. |
| vrdu-registration | 19830301_Tourism_Authority_of_Thailand,_New_York_Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | Tourism Authority of Thailand, Bangkok, Thailand | 14(a) Receipts-Monies From: Tourism Authority of Thailand, Bangkok | Bangkok head office named as source, distinct from NY registrant. |
| vrdu-registration | 19830801_British_Virgin_Islands_Tourist_Board_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Disbursements list only. |
| vrdu-registration | 19830801_British_Virgin_Islands_Tourist_Board_Amendment_Amendment.pdf | /signer_name | unverifiable | 1 |  | dense illegible scrawl, name/title lines blank | 'IMMACOLATA CARPINELLI' is the notary, not the signer. |
| vrdu-registration | 19830801_British_Virgin_Islands_Tourist_Board_Amendment_Amendment.pdf | /signer_title | absent |  |  |  | Only the scrawled signature, title lines blank, notary caption printed. |
| vrdu-registration | 19841001_Cayman_Islands_Department_of_Tourism_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Item 5 only responds 'No' to item 15. |
| vrdu-registration | 19841001_Cayman_Islands_Department_of_Tourism_Amendment_Amendment.pdf | /signer_title | absent |  |  |  | Handwritten signature, following lines empty. |
| vrdu-registration | 19850306_Daniel_J._Edelman,_Inc._Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | the Republic of Greece | Item 5: '...must be amended to list the name of the foreign principal, the Republic of Greece.' | Named explicitly. |
| vrdu-registration | 19850306_Daniel_J._Edelman,_Inc._Amendment_Amendment.pdf | /signer_name | visible | 2 | Stephen K. Cook | signature 'Steph. K. Cook' + typed name in page-1 box | Notary is a different hand. |
| vrdu-registration | 19850306_Daniel_J._Edelman,_Inc._Amendment_Amendment.pdf | /signer_title | absent |  |  |  | Individual registrant, title lines blank. |
| vrdu-registration | 19870302_FCB_New_York_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Corporate name-change amendment only. |
| vrdu-registration | 19870302_FCB_New_York_Amendment_Amendment.pdf | /signer_name | unverifiable | 2 |  | 'FCB/LEBER KATZ PARTNERS, INC. BY: [signature] / Vice President/Controller' | Given name reads 'Barry S.', surname an unreadable scrawl. |
| vrdu-registration | 19880501_Akin,_Gump,_Strauss,_Hauer___Feld,_LLP_Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | Tate & Lyle, PLC | Item 5.1: '...for the foreign principal Tate & Lyle, PLC...' | Explicitly labelled. |
| vrdu-registration | 19890201_Arnold___Porter_Kaye_Scholer,_LLP_Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | Banco Central do Brasil, Government of Brazil | Item 5: '...Exhibit B with respect to the Banco Central do Brasil and ... the Government of Brazil...' | Both principals named. |
| vrdu-registration | 19890201_Arnold___Porter_Kaye_Scholer,_LLP_Amendment_Amendment.pdf | /signer_title | absent |  |  |  | Typed 'Robert Herzstein', no title. |
| vrdu-registration | 19890501_Singapore_Tourism_Board_Amendment_Amendment.pdf | /file_date | visible | 2 | May 1, 1989 | 'Executed on May 1, 1989.' | Typed execution date above the signature. |
| vrdu-registration | 19890501_Singapore_Tourism_Board_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Only registrant + Chicago office appear. |
| vrdu-registration | 19900401_Tourism_Authority_of_Thailand,_Los_Angeles_Amendment_Amendment.pdf | /file_date | absent |  |  |  | Oath block entirely blank, other dates are period/stamp. |
| vrdu-registration | 19900401_Tourism_Authority_of_Thailand,_Los_Angeles_Amendment_Amendment.pdf | /foreign_principal_name | absent |  |  |  | Expense line items and partner orgs only. |
| vrdu-registration | 19900401_Tourism_Authority_of_Thailand,_Los_Angeles_Amendment_Amendment.pdf | /signer_name | absent | 2 |  | signature block entirely blank | Filed unsigned. |
| vrdu-registration | 19900401_Tourism_Authority_of_Thailand,_Los_Angeles_Amendment_Amendment.pdf | /signer_title | absent | 2 |  | blank signature/title lines | Never filled in. |
| vrdu-registration | 19910601_Representative_of_the_Turkish_Republic_of_Northern_Cyprus_Dissemination_Report_Dissemination_Report.pdf | /foreign_principal_name | absent |  |  | Item 5 = 'See Attached List.' | Attached list names recipients/titles, never a principal. |
| vrdu-registration | 19910801_Representative_of_the_Turkish_Republic_of_Northern_Cyprus_Dissemination_Report_Dissemination_Report.pdf | /foreign_principal_name | absent |  |  | Item 5 = 'See Attached List.' | Same pattern, no principal named. |
| vrdu-registration | 19920201_Sidley_Austin,_LLP_Amendment_Amendment.pdf | /foreign_principal_name | visible | 1 | Moscow Narodny Bank, Government of the Cayman Islands | Item 5: '...the foreign principals, Moscow Narodny Bank and the Government of the Cayman Islands...' | Explicitly labelled. |
| vrdu-registration | 19920201_Sidley_Austin,_LLP_Amendment_Amendment.pdf | /signer_name | unverifiable | 2 |  | cursive '...B. T____, Jr.' | Illegible, no typed name. |
| vrdu-registration | 19920201_Sidley_Austin,_LLP_Amendment_Amendment.pdf | /signer_title | absent |  |  |  | Lines under signature blank. |
| vrdu-registration | 19920301_Representative_of_the_Turkish_Republic_of_Northern_Cyprus_Dissemination_Report_Dissemination_Report.pdf | /foreign_principal_name | absent |  |  | Item 5 = 'See Attached List' | Cross-reference only, list not in the 2-page doc. |
| vrdu-registration | 19920501_Representative_of_the_Turkish_Republic_of_Northern_Cyprus_Dissemination_Report_Dissemination_Report.pdf | /foreign_principal_name | absent |  |  | Item 5 = 'See Attached List' | No list attached, no principal named. |
