// The hand-written word lists around the name registers: what announces a name, what never is one, and the familiar
// forms the PESEL register does not hold. Lowercase, separated by whitespace.

// Honorifics, after which any capitalized word is a person: "Pan Kowalski", "panią Nowak", "doktor Wilk". Whole
// words: followed by a dot they end a sentence ("…dla państwa. Szczególne…") rather than abbreviate anything.
export const TITLES_PL = `
pan pani pana panu panią panem panie doktor doktora doktorem profesor profesora profesorem profesorowi ksiądz księdza
mecenas mecenasa redaktor redaktora
`;

// Abbreviated titles and ranks: "dr hab. inż. Wilk", "płk Zając". Written with a dot, the dot is required ("prof."
// yes, "prof" no); without one, it may be there or not ("dr" and "dr.").
export const TITLE_ABBREVIATIONS_PL = `dr dra drem drowi mgr płk mjr inż. hab. prof. ks. mec. kpt. sierż.`;

// Offices and relations, after which a capitalized word is a person only if the name lists know it: "prezes
// Kowalski" and "kolega Marek", but "dyrektor Biedronki" and "klienta Google" are companies. With them the
// abbreviations that are also words, which a sentence may end on: "p.", "red." (English "red."), "gen.", "por."
// (Spanish "por").
export const ROLES_PL = `
p. red. gen. por.
prezes prezesa prezesem prezesowi prezeska prezeski dyrektor dyrektora dyrektorem dyrektorowi dyrektorka dyrektorki
kierownik kierownika kierownikiem kierowniczka minister ministra ministrem poseł posła posłem posłanka senator
senatora prezydent prezydenta premier premiera marszałek marszałka rektor rektora dziekan dziekana sędzia sędziego
sędzią prokurator prokuratora komisarz komisarza burmistrz burmistrza wójt wójta starosta starosty wojewoda wojewody
kolega kolegi kolegą koledze koleżanka koleżanki koleżanką koleżance sąsiad sąsiada sąsiadka brat brata bratem
siostra siostry siostrą żona żony żoną mąż męża mężem syn syna synem córka córki córką wujek wujka ciocia cioci
babcia babci dziadek dziadka klient klienta klientka klientki pacjent pacjenta pacjentka pacjentki pracownik
pracownika pracownica pracownicy
`;

// Words after which a capitalized word is a place, not a person: "ulica Grodzka", "przy ulicy Wileńskiej", "w gminie
// Kowale". Streets are named with adjectives that are also surnames, so without this every street is someone.
export const PLACE_WORDS = `
ul. ulica ulicy ulicę ulicą al. aleja alei aleję aleje pl. plac placu placem os. osiedle osiedla osiedlu rondo ronda
rondzie most mostu moście dworzec dworca stacja stacji park parku kościół kościoła parafia parafii gmina gminy gminie
powiat powiatu województwo województwa wieś wsi miasto miasta mieście jezioro jeziora rzeka rzeki szkoła szkoły
dzielnica dzielnicy
`;

// English short forms people sign with and are addressed by, which the birth registers record in full.
export const NICKNAMES_EN = `will bob rob dave matt nick sam pete ted ed liz meg jen jess josh nate zach tom jim joe mike kate`;

// English honorifics count only capitalized ("Mr Smith"); lowercase "ms" is milliseconds and "dr" a drive.
export const TITLES_EN = `Miss Sir Dame Lady Lord`;
export const TITLE_ABBREVIATIONS_EN = `Mr Mrs Ms Mx Dr Prof`;

// Capitalized words that are never part of a name, so they end one: function words that title case capitalizes, and
// the nouns of institutions, places and things that follow a first name in a heading ("Adam Optimizer", "Victoria
// Station", "Uniwersytet Warszawski").
export const NEVER_NAMES = `
the a an and or but nor in on at to for of with by from as is are was were be been has have had do does did not no
yes if then else when while this that these those it its he she we you they my your our their his her what which
who why how where all some each every new old first last next other also please thanks thank hello hi hey dear
i w z na do od po za nie tak jest są to ten ta te oraz lub albo ale czy jak gdy że się dla bez przez przy pod nad
przed u o też już tylko jeszcze bardzo
monday tuesday wednesday thursday friday saturday sunday february march july september october november december
street road avenue drive square park river lake mountain bridge hotel hospital university college school church
center centre group inc ltd llc gmbh company corp corporation foundation institute museum library airport bank
award prize cup edition version release update project team club fund act law rule theorem algorithm optimizer
model framework server client service services system systems platform cloud studio labs lab software technology
technologies solutions consulting partners holdings ventures capital media network games records press publishing
books magazine journal times post news daily weekly review report station line language engine console store
ulica ulicy ulicę aleja alei plac placu osiedle osiedla rondo most mostu dworzec dworca stacja stacji lotnisko
szkoła szkoły uniwersytet uniwersytetu politechnika politechniki akademia akademii instytut instytutu szpital
szpitala urząd urzędu sąd sądu bank banku spółka spółki fundacja fundacji stowarzyszenie muzeum teatr teatru kino
kościół kościoła firma firmy grupa grupy zespół zespołu klub klubu sejm senat ministerstwo ministerstwa
województwo powiat powiatu gmina gminy miasto miasta wieś rzeka rzeki jezioro wyspa
lodge manor castle abbey court gardens terrace cottage farm st
bóg boga bogu bogiem boże jezus jezusa jezusowi jezusem chrystus chrystusa maryja maryi maryję jesus christ god
`;

// Words with a surname's -ski/-ska ending that name no one: adjectives of places, nations and languages (surnames in
// the register too: Polski, Krakowski, Mazowiecki, but in "Uniwersytet Warszawski" or "Bank Polski" not anyone), and
// the everyday nouns in -ska (miska, maska, deska). Listed in the nominative; inflected forms reduce to it.
export const NOT_SURNAMES = `
polski polska warszawski warszawska krakowski krakowska gdański gdańska poznański poznańska wrocławski wrocławska
łódzki łódzka szczeciński szczecińska lubelski lubelska białostocki białostocka katowicki katowicka bydgoski
bydgoska toruński toruńska kielecki kielecka rzeszowski rzeszowska olsztyński olsztyńska opolski opolska
gorzowski gorzowska zielonogórski zielonogórska śląski śląska pomorski pomorska mazowiecki mazowiecka małopolski
małopolska wielkopolski wielkopolska dolnośląski dolnośląska podkarpacki podkarpacka podlaski podlaska lubuski
lubuska świętokrzyski świętokrzyska kujawski kujawska warmiński warmińska mazurski mazurska kaszubski kaszubska
tatrzański tatrzańska bałtycki bałtycka europejski europejska amerykański amerykańska angielski angielska
niemiecki niemiecka francuski francuska rosyjski rosyjska ukraiński ukraińska czeski czeska słowacki słowacka
litewski litewska włoski włoska hiszpański hiszpańska chiński chińska japoński japońska szwedzki szwedzka
norweski norweska duński duńska fiński fińska węgierski węgierska rumuński rumuńska bułgarski bułgarska grecki
grecka turecki turecka żydowski żydowska łaciński łacińska katolicki katolicka chrześcijański chrześcijańska
królewski królewska cesarski cesarska miejski miejska wiejski wiejska morski morska akademicki akademicka
uniwersytecki uniwersytecka niski niska laska łaska deska kluska ziemski ziemska miska maska kiecka ryska kluczyk
`;

// Familiar forms people go by in emails and chats (Kasia, Tomek, Bartek), which the register of official names lacks.
// They decline like the names they come from: Kasi, Kasię, Tomka, Tomkiem.
export const DIMINUTIVES_PL = `
ania kasia basia gosia zosia ola ala ela iza magda aga jola hania marysia jadzia krysia julka zuzia zuza natalka
wika ula ewka danka halinka ilonka iwonka tereska bożenka agatka dorotka martusia kinia madzia emilka helenka
tomek bartek wojtek krzysiek piotrek przemek darek mirek jarek sławek radek zbyszek grzesiek staszek józek franek
antek rysiek heniek mietek władek wiesiek maciek janek jasiek olek szymek kazik edek tadek romek witek zenek
gienek felek bolek lolek bronek czesiek stefek lutek jurek kamilek adaś jaś krzyś staś ignaś kubuś
`;
