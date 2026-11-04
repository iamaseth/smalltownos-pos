// Generic illustrative menu photographs. Photos are downloaded once and served locally.
// Product-specific uploaded photos always take priority.
const rules: Array<[RegExp, string]> = [
  [/burger|hamburger|cheeseburger/i, 'burger'],
  [/sandwich|toast|panini|club/i, 'sandwich'],
  [/pizza/i, 'pizza'],
  [/fries|chips|potato/i, 'fries'],
  [/fried rice|rice/i, 'rice'],
  [/noodle|pad thai|pasta|spaghetti/i, 'noodles'],
  [/salad|caesar/i, 'salad'],
  [/soup|broth/i, 'soup'],
  [/egg|omelette|breakfast/i, 'breakfast'],
  [/fish|seafood|shrimp|prawn|squid/i, 'seafood'],
  [/chicken|wings/i, 'chicken'],
  [/beef|steak|pork/i, 'meat'],
  [/spring roll/i, 'spring-rolls'],
  [/espresso|americano|black coffee/i, 'espresso'],
  [/cappuccino|latte|flat white|mocha/i, 'latte'],
  [/iced coffee|ice coffee/i, 'iced-coffee'],
  [/coffee/i, 'coffee'],
  [/smoothie|shake/i, 'smoothie'],
  [/orange|juice|lemonade|limeade/i, 'juice'],
  [/tea/i, 'tea'],
  [/cocktail|margarita|mojito|martini|daiquiri|negroni/i, 'cocktail'],
  [/whisk|bourbon|scotch|brandy|cognac/i, 'whiskey'],
  [/gin|vodka|rum|tequila|mezcal/i, 'spirits'],
  [/red wine|white wine|rose wine|wine/i, 'wine'],
  [/beer|lager|ale|stout|ipa/i, 'beer'],
  [/water|soda|cola|sprite|soft drink/i, 'soft-drink'],
  [/cake|dessert|ice cream/i, 'dessert'],
];
export function genericMenuPhoto(name: string): string | null {
  const key = rules.find(([pattern]) => pattern.test(name))?.[1];
  return key ? `/menu-generic/${key}.jpg` : null;
}
