/**
 * Dr. Aurelie Vance's notebook, 1893, placed at the depths it describes.
 * Dr. Vance, her notebooks and the Hollow Hill are fictional. Nothing here is
 * offered as natural history.
 *
 * `row` is the world row (0 = top of the case) where a fragment sits.
 * Fragments marked `stealable` are the ones the ants may borrow letters from.
 */
export interface Fragment {
  id: string;
  row: number;
  date: string;
  text: string;
  stealable: boolean;
}

export interface Plate {
  id: string;
  numeral: string;
  title: string;
  row: number;
  caption: string;
}

export const PLATES: Plate[] = [
  { id: "surface", numeral: "I", title: "The Surface", row: 2, caption: "Grass, seed heads, a crust, and the entrance mound." },
  { id: "upper", numeral: "II", title: "The Upper Galleries", row: 98, caption: "Traffic, the stores, and the midden." },
  { id: "nursery", numeral: "III", title: "The Deep Nursery", row: 284, caption: "Eggs, larvae, pupae; the nurses; the lamp." },
  { id: "royal", numeral: "IV", title: "The Royal Chamber", row: 490, caption: "The queen, and those who face her." },
];

export const FRAGMENTS: Fragment[] = [
  {
    id: "f1",
    row: 18,
    date: "3rd June, 1893",
    text: "The hill is sealed behind glass this morning and set upon the north bench. I have given it a crust, a scatter of seed, and a beetle from the window sill. By noon they had found all three.",
    stealable: true,
  },
  {
    id: "f2",
    row: 52,
    date: "5th June",
    text: "They go out by one door only, and whatever they find they bring back by the same road. The road is drawn on nothing but the air. The brass at the eastern corner of the frame does not sit true; I must have it seen to.",
    stealable: true,
  },
  {
    id: "f3",
    row: 128,
    date: "9th June",
    text: "The upper galleries are a market. Traffic in both directions, and at the narrow places a queue, which they keep better than the crowd at the omnibus stand.",
    stealable: true,
  },
  {
    id: "f4",
    row: 184,
    date: "14th June",
    text: "A midden. The dead are carried to the far end of a gallery and laid with the seed husks. No one is left where she falls. I find I cannot say the same of us.",
    stealable: true,
  },
  {
    id: "f5",
    row: 236,
    date: "20th June",
    text: "Rain in the night. The upper rooms flooded and by dawn every egg had been carried down. I did not see who gave the order. I do not think there was one.",
    stealable: true,
  },
  {
    id: "f6",
    row: 300,
    date: "2nd July",
    text: "Down here it is warm. I keep the lamp by this pane at night and the nurses have noticed: the brood lies where the glass is warmest, eggs with eggs, larvae with larvae, the cocoons apart.",
    stealable: true,
  },
  {
    id: "f7",
    row: 362,
    date: "8th July",
    text: "I have numbered the ones I can tell apart. It is a vanity. They do not know their numbers, and I cannot keep up with them.",
    stealable: true,
  },
  {
    id: "f8",
    row: 416,
    date: "11th July",
    text: "When the noon is hot they carry the pupae upward, toward the sun, and bring them down again at dusk. Every day. Nobody taught them the hour.",
    stealable: true,
  },
  {
    id: "f9",
    row: 506,
    date: "30th July",
    text: "The queen. I had to lower the lamp to see her at all. She hardly moves. The whole hill above her moves instead.",
    stealable: true,
  },
  {
    id: "f10",
    row: 556,
    date: "4th August",
    text: "Her attendants face her in a ring, like a small congregation. When she lays, the eggs are taken away before they touch the floor.",
    stealable: true,
  },
  {
    id: "f11",
    row: 604,
    date: "12th August, late",
    text: "I have begun to think of the hill as one animal and the ants as its cells. That is a figure of speech. I write it down so that I may disown it later.",
    stealable: true,
  },
];

export const INSTRUCTIONS = [
  "Nothing written yet today. The colony keeps your clock and goes on living when you leave.",
  "Your pointer is the observation lamp: hold it over the glass. Click any ant to read its card.",
];

export const COLOPHON =
  "The Hollow Hill is a fiction. Dr. Aurelie Vance, her notebooks and her formicarium never existed. The colony borrows the habits of real ants, but nothing here is offered as natural history. It lives in this browser alone, keeps your local time, and is shared with no one.";
