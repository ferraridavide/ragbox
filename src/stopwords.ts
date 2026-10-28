// Very common words dropped from keyword (full-text) queries so that matches on
// "the", "di", "und", ... don't outrank real term matches. Covers English,
// Italian, Spanish, French and German.
export const STOPWORDS = new Set(`
a an and are as at be but by for from has have he her his i if in into is it its me my not of on or our she so than that
the their them then there these they this those to us was we were what when where which who why will with you your
do does did how can could would should about after all also any been before being both each few more most other over
some such only own same too very just no nor off once out up down again further here
il lo la i gli le un uno una di da del della dello dei degli delle al allo alla ai agli alle dal dalla dai dalle nel
nella nei nelle sul sulla sui sulle con per tra fra e ed o che chi cui non come dove quando anche ma se sono sei è
era erano essere ha hanno ho questo questa questi queste quello quella quelli quelle mi ti si ci vi ne più
el los las unos unas y en por para con sin sobre es son fue como pero sus su al lo del
le les des du de et à au aux en dans par pour sur avec sans est sont ce cette ces qui que ne pas plus ou
der die das den dem des ein eine einer eines einem und oder zu im in ist sind war mit von für auf an aus bei nicht
`.split(/\s+/).filter(Boolean));
