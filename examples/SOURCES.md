# Example models: sources and licences

These are the models the app is tested on, and models to try it with. They are other people's work, shared on [Printables](https://www.printables.com) under the licences below, which were read from Printables' public API on 2026-11-11.

**They are not covered by Mold Form Generator's MIT licence** (`LICENSE`): each model keeps its author's terms.

- **NonCommercial (NC)** models may not be used for commercial purposes.
- **NoDerivatives (ND)** models are shared here unmodified, as their licence allows only that.
- **ShareAlike (SA)** models stay under their own licence, and so does anything made from them that is shared. The modified chick is shared under its original's licence, CC BY-NC-SA 4.0, as that licence asks.
- **CC0** models are dedicated to the public domain by their authors.

Some models are fan works, which their authors shared as such: any names, characters or items they show belong to their owners.

| File | Model | Author | Licence | Modified |
|---|---|---|---|---|
| `3dbenchy.stl` | [3D BENCHY](https://www.printables.com/model/3161) | Prusa Research | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication) | No |
| `barricate_type_2_straight.stl` | [Modular Sci-Fi Barricade & Cover Set for Tabletop Games/Wargames Terrain](https://www.printables.com/model/1569744) | JD | [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) | No |
| `charge-and-play-stand.stl` | [Charge and Play Stand](https://www.printables.com/model/20621) | docvalentine | [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/) | No; only the file is renamed |
| `chick_mc.stl` | [Chirpy the Chick](https://www.printables.com/model/813441) | 3DMDesign | [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/) | Yes, by the owner of this repository; the file is 6 overlapping parts, as for multi-colour printing |
| `Damaged 40ft Shipping Container.stl` | [N Scale Damaged Shipping Container](https://www.printables.com/model/303129) | Jordan Ludusan | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication) | No |
| `doomedmarine.stl` | [Doomed Marine](https://www.printables.com/model/217355) | Heribertohobby | [Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International](https://creativecommons.org/licenses/by-nc-nd/4.0/) | No |
| `Factorio gear.stl` | [Factorio Gear](https://www.printables.com/model/940009) | Sacharis | [Creative Commons Attribution-NonCommercial 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/) | Format only: converted from the author's 3MF, see below |
| `Goddess Statue.stl` | [Goddess Statue](https://www.printables.com/model/639183) | [printables.com/@Link](https://www.printables.com/@Link) | [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/) | No |
| `jersey-barrier.stl` | [Jersey Barriers for 28mm Gaming](https://www.printables.com/model/166787) | paralepsis | [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/) | No |
| `jersey-barriers-x8.stl` | [Jersey Barriers for 28mm Gaming](https://www.printables.com/model/166787) | paralepsis | [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/) | No |
| `N Scale Oil Barrel.stl` | [N Scale Oil Barrel](https://www.printables.com/model/303131) | Jordan Ludusan | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication) | No |
| `war-barricade.stl` | [Grimdark War Barricade](https://www.printables.com/model/1524239) | Mike Hokage | [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) | Yes, by the owner of this repository |
| `wolfinal.stl` | [Low Poly Howling Wolf 2.0 (Decoration)(No Supports!) FIXED](https://www.printables.com/model/386392) | BP3D | [Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International](https://creativecommons.org/licenses/by-nc-nd/4.0/) | No |

The author is the name Printables shows for them, or for one the address of their profile there, and the model's name links to its page by the model's number, which Printables takes to the page. Two models go by a shorter name here than their titles on Printables, which name other companies' trademarks: the Charge and Play Stand and the Goddess Statue. The licences are the 4.0 International versions, as each page links to them, and CC0 1.0 for the public domain dedications.

`Factorio gear.stl` was converted from the author's 3MF file, as the app reads STL only: its one mesh, in metres in the 3MF, was written as a binary STL in millimetres, with the same 3,592 triangles and their winding (39 x 39 x 5 mm). That is a change of format only, which the Creative Commons licences allow anyone to make: section 2(a)(4) of the 4.0 licences permits the technical modifications needed to use a work in other media and formats, and says these never make an adaptation.

Two further test models, `VIS-35-skan-skalowany.stl` and `l_medieval_barrel.stl`, have no known source. They are kept only on the maintainer's machine, `.gitignore` names them, and they are not published. The tests that need them skip without them, naming the file and this page, and the loops over every example leave them out.

## Adding a model

Add the file to `examples/` and a row to the table above, with the model's Printables page by its number (`https://www.printables.com/model/<number>`), its author, its licence and its deed, and whether it was modified and how. Only models whose source and licence are known, and whose licence allows sharing them, belong here. `test/unit/examples.test.ts` fails when a file git tracks in `examples/` has no row, or a row has no file.
