# From print to recast: the maker's workflow

This is the whole job, from the first print to casting copies in the finished mold. README.txt in each export ZIP has the same steps for that one mold, with its own numbers: the tape, the silicone, the places to cut. Where the two differ, README.txt is about your mold and this file is the general guide.

The steps at a glance:

1. Set up the mold in the app.
2. Check your printer with the fit test.
3. Export and print the parts.
4. Test your materials for cure inhibition.
5. Join the base and the cover, seal them, and test for leaks with water.
6. Glue the model in (Mode A), and close the mold for the pour.
7. Mix, degas and pour the silicone.
8. Let it cure.
9. Cut the sprues.
10. Demold.
11. Use the finished mold.

## What you need

- An FDM printer for the base, the cover and the funnel. For Mode A, any printer for the model, a resin printer included.
- Two-part silicone rubber made for molds, with its data sheet: mixing ratio, working time, cure time and what it must not touch.
- Scales or measuring cups, a mixing cup with room for the silicone to rise, and a stirring stick.
- Adhesive tape, and petroleum jelly (Vaseline) for the groove. Or, with the bolts turned on, four countersunk screws and four hex nuts: README.txt lists the size and length. The app counts the strips of tape from what one strip holds, 10 N by default; if your tape holds more or less, set Tape strip holds under Advanced, Printer.
- A glue for Mode A that you have tested with your silicone.
- A sharp blade, such as a scalpel or hobby knife.
- If you have one: a vacuum chamber and pump for degassing.

This guide names no brands. Use what your silicone's maker says works with it.

## 1. Set up the mold in the app

1. Open your STL with Open STL or project, at the top of the sidebar, or drop the file on the view.
2. Check the base face. The app lists the flat faces the model could stand on, best first, and picks the first. Make sure it is the face your model stands on; if not, choose another from the list, or Pick a face on the model.
3. Choose glue-in (Mode A) or merged (Mode B) under Base, as below.
4. Set your printer: the Layer height under Base, and under Advanced, Printer, the Nozzle and the Bed X, Y and Z of your printer.
5. Look over the rest, such as the silicone thickness under Silicone or the copies under Grid. The Diagnostics card in the view says what needs your attention.

### Glue-in (Mode A) or merged (Mode B)

Mode, under Base, chooses how the model and the base come together: Glue in (A) or Merged (B).

- **Glue-in, Mode A** (the default): you print the model on its own and glue its flat face into a shallow pocket in the base. The model can be printed in whatever pose suits it, on a resin printer for fine detail if you like. The ZIP holds it as `model_oriented.stl`, turned so its flat face lies at the bottom.
- **Merged, Mode B**: the model is built onto the base, and they print as one part. There is nothing to glue, but the model has to print standing on the plate, and its own overhangs may need supports. Diagnostics says how much area overhangs.

Use Mode A for a model that stands on several footprints, such as the wolf on its feet. Silicone flows between the feet and holds the model in a loop there, and the Demold report marks those places to cut. In Mode A the base is a separate piece: the glue joint is only as large as the footprints, so you can lever the base off and free the model from the silicone on its own. In Mode B the plate is part of the model, so it stays on the model and is in the way while you cut between the feet. Mode A also lets the model print in a pose that needs no supports under its body.

Merged mode is off for a mesh with holes (an open mesh), and the reason shows under Mode.

## 2. Check your printer with the fit test

Every printer prints a little over or under size. The joint between the base and the cover has small clearances, so find the ones that suit your printer before you print a whole mold.

1. With your model open, click Fit test under Export, at the foot of the sidebar. Like every export button, it stays off until a model is open. You get a ZIP of small test pairs, about 40 mm square, built at the layer height, the joint and, with the bolts on, the bolts you have set. Each pair is a little mold with the real taper, ridge and groove, a pour bore, a funnel seat and a vent.
2. Print the taper series first, in the material and settings you will use for the real mold, in the poses the files are saved in. Notches on the +x side tell the pairs apart: one notch for the first, two for the second, and so on.
3. Find the tightest pair whose base seats fully on the cover's shelf by hand. When it seats, the base stands 0.2 mm proud of the cover's bottom edge. If it rocks or stands higher, go one step looser. Set Taper clearance per side under Cover & joint to that pair's value.
4. If that value differs from the one the groove series was built at, save the fit test again with the Fit test button: the groove series is always built at the taper clearance that is set.
5. Print the groove series (notches on the +y side). Choose the tightest pair that still seats fully, and set Groove clearance per side to its value.
6. A chosen pair also works as a small leak test, and even as a small test pour: see step 5 below.

If no pair seats, `fit_test/README.txt` in the ZIP says what to try.

`diag.html`, the Browser check under Advanced, Developer pages, also saves a fit test without a model. It builds the pairs at the app's default settings, apart from the taper clearance you type there, and it has no bolt coupon. So use the Fit test button for a printer with another layer height, or with the bolts on.

### The bolt coupon

With Nuts and bolts turned on, in the Bolts group at the foot of Cover & joint, the fit test also holds `bolt_coupon_base.stl` and `bolt_coupon_cover.stl`: a corner of the base with one countersunk hole, and a corner of the cover with one nut slot. Print them like the real parts, then:

1. Push a nut into the slot from the +x side, corner first, with two of its flats against the sides of the slot. It should slide in by hand until its leading corner stops at the end of the slot, and stay there. If it will not go in, raise Nut clearance per side by 0.05 mm. If it falls out, lower it.
2. Put the screw up through the base piece from underneath and into the cover piece. The first time, it pushes through a thin layer of plastic between the hole and the slot, under the nut. That layer is meant: it lets the slot's ceiling print as a whole bridge. If the screw binds in its hole, raise Hole clearance per side.
3. Turn the screw into the nut until snug. Its head should sit flush with the underside or a little below it, and the two pieces should close with no gap.

## 3. Export and print the parts

Once the clearances from the fit test are set, click Export ZIP under Export. It builds the mold at full detail, measures the silicone thickness on the finished parts, and saves a ZIP named after your model with `cover.stl`, `base.stl`, `funnel.stl`, `model_oriented.stl` in Mode A, and README.txt with this mold's own numbers. Whenever you change a setting, the clearances among them, export again: the ZIP holds the mold as it was set when you clicked.

- **Poses:** every part is saved the way up it prints best. Do not flip a part over or lay it on another side in your slicer. Turning it about the vertical axis to fit your bed is fine, and Diagnostics says when a part only fits turned.
- **No supports:** the cover prints flat top down. Its only overhangs are the cone of each funnel seat, at 30 degrees from vertical at the defaults, and, with the bolts on, the ceiling of each nut slot, a short bridge your slicer prints straight across. The base prints flat underside down, and the funnel wide rim down. Turn supports off for all three. In Mode B only the model's own overhangs may need them.
- **Layer height:** print at the layer height set under Base (0.2 mm by default). The base and the pocket are sized in whole layers of it, so the slicer does not round them. If you set a Thickness or a Pocket depth under Base that is not a whole number of layers, the app warns under that control. Check the pocket depth and the base in your slicer's layer preview.
- **Walls and infill:** about 35 percent infill is enough. Use at least 3 walls (perimeters) and 4 top and bottom layers, so the surfaces that touch silicone are solid and nothing seeps through.
- **The base stands 0.2 mm proud:** once seated, the base stands one layer proud of the cover's bottom edge. That is meant. The first layer of a print often squashes a little thinner, and a base that ended up recessed would let the cover's wall stand on the table, so the tape or the bolts would no longer pull the base against the seal.
- **Size:** if a part is larger than your bed, even turned, Diagnostics says so and what would help, such as fewer copies in a grid. Diagnostics and README.txt also estimate the plastic.
- **The funnel:** print one for each pour opening. README.txt gives the number. If the funnels would touch each other on a grid, the funnel warning suggests a smaller top diameter, or you pour through one funnel at a time.
- **The model (Mode A):** print it however suits it, on any printer. README.txt says how many to print for a grid.

## 4. Test your materials for cure inhibition

Some materials stop silicone from curing where they touch it. The silicone then stays sticky or soft there, and the mold's surface is spoiled. This is called cure inhibition. Test before you pour a whole mold.

**Which silicone is sensitive:** platinum-cure (addition-cure) silicone is the sensitive kind. Tin-cure (condensation-cure) silicone is much less sensitive, though not immune. Your silicone's data sheet says which type it is and lists what it must not touch.

**Known risks,** as silicone makers commonly list them. This list is not complete, and your silicone's data sheet comes first:

- resin (photopolymer) prints, above all ones not fully washed and cured;
- sulfur, found for instance in some modelling clays and in latex gloves;
- tin compounds, including traces of tin-cure silicone on a surface or tool;
- amines, as in some epoxy hardeners;
- some glues, some tape adhesives, some sealants, and some paints and primers.

FDM plastics cause trouble less often, but additives, colours and coatings vary, so test those too.

**The test patch:** print a small scrap in each material you will use, the model's and the base's and cover's, with the same settings. Put a dab of the glue you will use on it (Mode A), a strip of the tape, and a smear of the petroleum jelly or sealant. Pour a small patch of your silicone over all of it and let it cure for the full time its maker gives. If it stays sticky or soft anywhere it touches, do not use that material as it is. Seal the surface, for example with a clear coat, or choose another material, and test again: a coat needs its own test.

Resin prints: wash and post-cure them fully, as the resin's maker says, before the test and before the pour.

## 5. Join the base and the cover, seal them, and test for leaks with water

Do this once before the model is glued in, so the water never touches the model or the glue. The test checks your print and your way of sealing it; for the pour you seal the mold again the same way.

1. Spread a thin film of petroleum jelly (Vaseline) in the groove of the cover. It helps the joint seal, and the leak test shows whether your joint needs more.
2. Fit the base into the cover: the ridge on the base goes into the groove. Press until the base rests on the cover's shelf all round. It then stands 0.2 mm proud of the cover's bottom edge.
3. Hold it closed, in one of two ways:
   - **With tape:** Cover & joint says how many strips, and README.txt repeats it. Each strip runs from a side wall of the cover, across the base, to the opposite wall. Spread them evenly, at least one each way, no more than about 100 mm apart along any wall, so the tape presses the seal all round. The count holds twice the lift of the liquid silicone on the cover, and never less than 10 N, at the force each strip holds, which is Tape strip holds under Advanced, Printer (10 N by default). To judge your tape, stick a strip across two printed scraps as it would go on the mold, and hang a weight from one: 1 kg pulls with about 10 N. A tape that lets go sooner needs a lower figure there, and gets more strips.
   - **With the bolts:** before you join the parts, push a nut into the slot in each corner of the cover, from the side wall, corner first, with two flats against the sides of the slot, until it stops over the hole. Then put a screw up through each corner hole of the base and turn it into its nut. The first time, each screw pushes through a thin layer of plastic under the nut, which is meant. Tighten the screws in turn, a little at a time, until snug, and no more: a printed plate bends if the screws are forced, and the seal then opens between the corners. Where the bolts stand more than about 100 mm apart, also tape across the middle of that side. Cover & joint and README.txt say where.
4. **Leak test with water before the first pour.** Stand the mold on its base and fill it with water through the pour opening until water shows at the vents. Let it stand for several minutes. The joint should stay dry. If it leaks, open it, clean the groove, and seal it again, with more petroleum jelly or more tape, and test again.
5. Pour the water out, take the mold apart, and let the parts dry fully before silicone goes in.

Water is lighter than silicone, and it is not poured up into the funnels, so the joint takes more in the real pour than in this test. The tape count or the bolts allow for that, at twice the lift of silicone up to the rim of a full funnel.

## 6. Glue the model in (Mode A), and close the mold for the pour

1. **Mode A:** glue the model's flat face into the pocket of the base, using a glue that passed the test patch. The pocket is 0.2 mm larger than the model's footprint all round, by default, so the model drops in. A grid has one pocket for each copy, and README.txt says how many models to print. Let the glue cure fully. Wipe off any glue that squeezes out, as the silicone will copy it.
2. **Air the vents cannot reach.** The app places a vent at each high point of the cover's ceiling. But air can also stay in a pocket under an overhang of the model, where no vent in the top reaches. The Demold report and README.txt's AIR section list each such pocket, with where it is. For those, while the model can still be reached: mix a small batch of silicone and brush a first coat of silicone onto the model there. Then close the mold and pour the rest within the time your silicone's data sheet gives for a second coat to bond to the first.
3. **Close the mold** as in step 5: petroleum jelly in the groove, the base fitted, and the tape or the bolts.

## 7. Mix, degas and pour the silicone

1. **Stand the mold level** on its base, and push a funnel into the seat of each pour opening. Do this first, as the silicone's working time starts when you mix it.
2. **How much:** the Silicone section and README.txt give the silicone in ml and in grams, at the density set under Silicone. Mix a little more, for what stays in the cup.
3. **Mix** the two parts by the ratio and the method your silicone's maker gives, within its working time.
4. **Degas in the cup,** if you have a vacuum chamber. The silicone foams up under vacuum, so use a cup several times larger than the silicone, and let the air back in once the foam collapses.
5. **Pour slowly,** in a thin, steady stream, into the funnel. The silicone fills the cavity from the bottom up and pushes the air out through the vents and the pour opening. Keep pouring until silicone shows at every vent. A mold with several pour openings has a funnel in each, or pour through one at a time, moving it from seat to seat.
6. **Under an overhang,** besides the first coat of step 6, tilting the mold a little as you pour can let the air escape. To degas the filled mold in a vacuum is untested for printed molds: air held in the infill of the walls can expand under vacuum and come through into the silicone, and the joint has only been tested with water. If you want to try it, first fill a fit-test pair with silicone, put it under vacuum, and look at the cured silicone along its walls for bubbles. If you do degas the filled mold, watch the funnels, as the silicone rises while it foams, and let the air back in before it overflows.
7. The app's air report assumes the silicone rises slowly and evenly. A fast pour can trap air elsewhere too.

## 8. Let it cure

Leave the mold standing level for the full cure time your silicone's maker gives, at the temperature they give. Do not open it early: silicone that feels set on top can still be soft inside.

## 9. Cut the sprues

Silicone fills the pour bores, the funnel seats and the vents. Cut it before you take the mold apart.

- **Pour openings:** take out the funnels. Cut each pour sprue at the floor of its seat, where the cone meets the straight bore, not flush with the top. A cone of silicone left in the seat is wider than the bore under it, so it would lock the mold in the cover. This holds when you pour without a funnel too: then silicone fills the cone-shaped seat itself.
- **Vents:** cut the silicone in each vent flush with the top.
- **No funnel seats:** if Funnel seat is off under Pour & funnel, cut the silicone in each pour opening flush with the top too.

## 10. Demold

The Demold report, in the sidebar after Grid, estimates from the model's shape how the silicone comes off it. README.txt's DEMOLDING section has the same. It is an estimate, worked out from the shape alone, so treat it as a guide.

First take the base off: take off the tape, or unscrew the four bolts from under the base and leave the nuts in their slots for the next pour. Lever the base out at the pry notches on the bottom edge of the cover. Then follow the verdict:

- **Pull out in the cover:** the model should pull out of the silicone with the base, while the silicone stays in the cover. If the model holds, slide the silicone out of the cover with the model in it, flex the silicone to free the model, and put the silicone back into the cover the way it came out.
- **Silicone out first:** slide the silicone out of the cover with the model still in it. The cover widens towards the base, so the silicone slides out that way. Stretch the silicone off the model where it holds. Cut it with a sharp blade only where it would tear. Take out the model, and put the silicone back into the cover, the way it came out.
- **Cutting needed:** slide the silicone out of the cover with the model still in it, as above. The report lists the places marked **Cut** first: there the silicone holds the model in a loop, as between the feet of a model on several footprints, and it must be cut. Cut with a sharp blade, in a wavy line so the cut faces line up again, then stretch the silicone off where it still holds. Take out the model, and put the silicone back into the cover.

The report shows the first six places, the places to cut among them first, each with a Show button that marks it on the model in the view, and says how many smaller ones there are besides. README.txt lists every place in words, measured from the middle of the model, with the front being the side you face in the app's first view.

Putting the silicone back into the cover matters: the cover holds the flexible silicone in shape when you cast into it.

## 11. Use the finished mold

The silicone in the cover is your finished mold. Turn it over: the cover's flat top is now the bottom of your mold, so it stands flat on the table, and you cast into the opening where the base was. Cast your material as its maker says, and test it on a scrap of the cured silicone first if you are not sure the two get along.

To make the same mold again, open the STL in the app, then open the export ZIP or its `project.json`: the settings, the base face and the openings come back as they were.

## What only you can find out

The app measures the geometry: the silicone thickness, the closed cavity, the openings at the high points, the parts that need no supports. Some things depend on your printer, your silicone and your hands, and only a test can tell:

- **Whether 3 mm of silicone holds up in use.** 3 mm is the default thickness, and no published source shows that it is enough. A thicker setting under Silicone costs more silicone and gives a stronger mold; the app advises 4 to 5 mm for a cavity taller than 100 mm.
- **How a top pour fills your mold,** and whether air stays anywhere the report did not expect.
- **Whether the joint seals** on your print, with tape, petroleum jelly or bolts. The leak test in step 5 shows it before any silicone is spent, though with less push than the silicone gives.
- **Whether your tape holds** what Tape strip holds says, 10 N a strip unless you set another figure.
- **Whether a vacuum on the filled mold** pulls air through the printed walls. A filled fit-test pair under vacuum shows it, as step 7 says.
- **Cure inhibition** with your silicone, print material, glue, tape and sealant. The test patch in step 4 shows it.
- **Whether the demold estimate holds** for your model.

Make a test pour before you rely on a mold. The fit-test pieces are small enough to try a pour on first.
