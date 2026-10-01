// Names that are also ordinary words, so a capitalized one proves nothing on its own: it may start a sentence, title a
// heading or name a product. These count as a name only beside other evidence (a surname, a title, a "name" field).
// Written by hand from the overlap of the name lists with the frequency lists of Polish and English text; each entry is
// the word as written, lowercase, since "Róży" is a name where "róża" alone may be a flower.

// English names that are words (Will, Mark, Grace), months, places, and the colours and trades among the surnames.
export const AMBIGUOUS_EN = `
will mark max may june april august january grace hope rose faith joy summer autumn dawn winter spring
bill jack frank art gene pat sue guy don ray drew dean earl lance grant chase hunter mason wade kent troy chad
amber crystal ruby jade pearl opal ivy holly hazel heather violet daisy lily iris jasmine rosemary flora aurora
destiny trinity serenity genesis harmony melody liberty charity mercy honor misty sandy brandy sherry penny ginger
candy cherry honey sunny lucky rocky rusty buddy chip chuck skip ace sky river storm rain
angel christian royal king prince princess duke baron major general bishop pope noble sterling rich
roger miles said semen german roman marine marina vital vita ion gal emir ester florin pascal august
paris london sydney austin dallas houston phoenix florence georgia virginia carolina dakota savannah brooklyn
chelsea madison lincoln jordan israel asia india victoria sierra catalina mercedes harley
claude devin gemma alexa siri cassandra travis jenkins
white brown green black gray grey young long little short strong wise small sharp
hill wood woods stone bell ford cook hunt rice fox hall west day love wells bush wolf banks burns fields rivers
baker ball barber barker bass bean beard berry best bird bond booth branch bray brewer bright buck butler cannon
carpenter case church clay cox crane cross curry drake dyer english farmer fisher freeman french fry fuller gamble
garner gay glass golden good goodman griffin hale hardy hart heath herring holder holt hood horn house huff hull
key knight lamb lane leach marsh mercer moody moon moss newton pace page peck petty pierce porter potter price
reed riddle roach rush savage shepherd skinner snow stark stout tanner walker wall ward ware waters weaver
gates jobs dell
any nice ally polo mayo lei they very lady tiny mice belly martini gala taro rosy sari den dale mira dance ago albino
`;

// Polish names that are words: the spec's own examples (Róża, Wiktoria, Wilk, Lis…), inflected forms of names that are
// everyday words (mają is "they have", idzie "goes", inny "other", olej "oil"), and surnames that are animals, colours,
// trades, seasons and days.
export const AMBIGUOUS_PL = `
róża róży różę różą wiktoria nadzieja nadziei nadzieję nadzieją sława sławy sławę sławą rada rady radę radą radzie
pola polu kara karę kary karą karze lina linę liny linie liną luka luki lukę luką kuba kuby kubie kubę kubą
marka marki markę marką marce mają maju idę idą idzie inna inny inni innej inną mili milę miej olej ani kim
dana dany danej daną dano danym lada luba lubi lubię lubie sami samego samemu dali rosa malina lew lwa lwem lwie lewa
sylwester sylwestra wita roma taras tarasie boska boski boskiej boskim islam izrael rola rolę roli rolą sam marzenie ano jagody polej lino lilie milej wice wiki
miau mię mii
wilk lis kot zając król kowal baran sowa mróz kruk wróbel kamień szewc nowy nowa polak góra
data sobota niedziela środa piątek wtorek czwartek poniedziałek marzec kwiecień czerwiec lipiec sierpień wrzesień
październik listopad grudzień styczeń luty zima wiosna lato jesień śnieg deszcz grad burza wiatr
biały biała czarny czarna zielony zielona siwy siwa rudy ruda mały mała wielki wielka długi długa krótki gruby
chudy młody stary dobry cichy wolny prosty twardy kraj rok rząd głos sztuka szkoda zgoda zasada forma figura klasa
sala szkoła kawa pogoda blok park para ryba rak karp kura kogut koza byk mucha komar pszczoła ptak sroka wrona kos
sokół orzeł gołąb bocian sikora czajka kawka pająk motyl żaba wąż jeż borsuk dzik jeleń sarna łoś kuna ryś
dąb buk grab brzoza lipa sosna wierzba orzech mak groch kapusta burak cebula marchewka ogórek kasza kosz piec
noga głowa broda wąs kość skóra dusza duch duma bieda wojna przerwa poprawa porada pokora potęga muzyka zabawa
`;
