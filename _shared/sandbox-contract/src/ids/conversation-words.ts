// The words a fresh conversation id is drawn from (`newConversationId`): everyday concrete nouns (animals, food,
// nature, things, places) that a non-native English speaker reads and spells at sight, three to six letters, lowercase
// a-z only. Kept out: rare or hard-to-spell words, slang and words with a rude second meaning, and words that already
// mean something in git or in this app's id space (`main`, `fork`, `branch`, `home`, `link`, `sub`, `job`, `web`), so an
// id never reads as a ref, a command or one of the derived, prefixed ids. Alphabetical, one space apart, so a
// duplicate shows; the test holds the rules.
export const CONVERSATION_WORDS: readonly string[] = `
acorn alley almond alpaca amber anchor ant apple apron arena arrow aspen atlas atom attic aurora autumn avenue
badge badger bag bagel bakery ball bamboo banana banjo banner barn barrel basil basket bay beach bean bear
beaver bed bee beet beetle bell belt bench berry bike birch bird bison boat book boot bottle bowl box bread
breeze brick bridge brook broom brush bucket bud bun bunny burger bus bush butter button cabin cactus cafe cake
calf camel camera canal canary candle candy canoe canvas canyon car card carpet carrot cart cashew castle cat
cave cedar celery cellar cello cereal chair chalk cheese cherry chess chick chili cider city clam cliff clock
cloud clover coast coat cobra cocoa cod coffee coin comb comet comic cookie copper coral cork corn cosmos cougar
coyote crab crane crater crayon cream creek crepe crown cub cup curry daisy dawn deer delta desert desk dew
diary dice dish dog doll domino donkey donut door dove dream dress drum duck dune dusk eagle earth echo egg elk
ember emu eraser falcon fan farm fawn fence fern ferret field fig fish flag flame floor flour flower flute foal
fog forest fox frame frog frost fudge galaxy garage garden garlic gate gecko gem ginger glass globe glove glue
goat gold gong goose grape grass grove guava guitar gulf gull hail hammer harbor hare harp hat hawk hazel helmet
hen herb heron hill hippo honey hoodie hook horn horse hotel hut ice igloo iguana inn iris iron island ivy
jacket jade jaguar jam jar jelly jet jewel juice jungle kale kayak kettle kiosk kite kitten kiwi knot koala
ladder lagoon lake lamb lamp laser latte lava leaf lemon lens lilac lily lime lion lizard llama lobby lodge loft
lotus lynx magnet mango map maple marble market marsh mask meadow medal melody melon meteor milk mill mint
mirror mist mitten mocha monkey moon moose moss moth mouse movie muffin mug mule museum nail napkin nebula
nectar needle noodle noon novel oak oar oasis oat ocean olive onion opal orange orbit orca orchid otter oven owl
oyster paddle paint palace palm pan panda papaya paper parcel park parrot pasta pea peach peak peanut pear pearl
pebble pen pencil pepper petal phone photo piano pickle pie pier pigeon pillow pine pixel pizza plane planet
plate plaza plum pocket poem pollen pond pony pool poppy porch poster pot potato puddle puffin puma puppy purse
puzzle quartz quilt rabbit radio radish raft rain rake ramen ranch raven reed reef rhino ribbon rice ridge ring
river robin robot rock rocket roof rope rose ruby rug ruler saddle sage sail salad salmon salt sand sauce scarf
scone sea seal seed sesame shark sheep shelf shield ship shirt shoe shop shore shovel shrimp silver skate ski
sky sled sloth smile snail snake snow soap sock soda sofa soil song soup spark spider sponge spoon sprout squash
squid stamp star statue stone stool stork storm stream street studio sugar summer summit sun sunset sushi swan
syrup taco tape taxi tea teapot teddy temple tent ticket tide tiger toad toast toffee tofu tomato torch toucan
towel tower town toy train tram tray tree trophy trout truck tub tuba tulip tuna tundra tunnel turnip turtle
twig valley van vase vine violet violin wafer waffle wagon wallet walnut walrus watch wave whale wheel willow
wind winter wolf wood yak yard yogurt zebra zipper
`
    .trim()
    .split(/\s+/);
