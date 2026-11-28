// El icono de una comida según lo que es (no según cómo se anotó): se busca en su nombre qué alimento principal lleva (`domain/name-match.ts` explica cómo se elige).
// Una prueba comprueba que cada alimento de la tabla de `src/data/foods` tiene un icono propio y no el cubierto de lo que no se reconoce.

import { bestRule, compileRules, type Role } from '../domain/name-match';

const RULES: ReadonlyArray<readonly [icon: string, role: Role, words: string]> = [
  // ───────────── desayuno, bollería y dulces ─────────────
  ['Croissant', 'main', 'croissant|cruasán|napolitana|ensaimada|palmera|bollería|brioche|bollycao|bollo|caracola|xuxo|trenza|roscón|hojaldre|pain au chocolat|empanada|empanadilla|samosa|medianoche|kanelbulle|scone|medialuna|kouign-amann|kouign amann|sfogliatella|carbayón|carbayones|cornish pasty|pastela|brik|samsa'],
  ['Donut', 'main', 'donut|rosquilla|berlina|churro|porra|buñuelo|dunkin|munchkin|youtiao|pestiño|sopaipilla|jalebi|gulab jamun'],
  ['Cupcake', 'main', 'magdalena|muffin|cupcake|mantecado|polvorón|bizcochito|mantecada|sobao|madeleine|canelé'],
  ['Cake', 'main', 'bizcocho|plum cake|panettone|red velvet|carrot cake|tarta de cumpleaños|brazo de gitano|selva negra|stollen|lamington'],
  ['CakeSlice', 'main', 'tarta|pastel|brownie|tiramisú|milhojas|pionono|tartaleta|coulant|profiterol|eclair|tocino de cielo|pastelillo|pastelito|pastel de nata|pastel de belén|pastel de belém|baklava|cannoli|clafoutis|dan tat|butter tart|pumpkin pie|quesada|gâteau vasco'],
  ['Cookie', 'main', 'galleta|cookie|oreo|digestive|príncipe|dinosaurus|barquillo|biscuit|cracker|fontaneda|chips ahoy|macaron|alfajor|mooncake|cantucci|lebkuchen|pop-tarts|pop tarts|panellets|casadielles|galleta bretona|galette bretona'],
  ['chocolate', 'main', 'chocolate|turrón|kinder|bombón|snickers|mars|twix|kitkat|kit kat|milka|lindt|toblerone|ferrero|conguitos|lacasitos|m&m|bounty|barrita|tableta|cacao en polvo|cacao puro|brigadeiro'],
  ['Candy', 'main', 'caramelo|chuche|gominola|regaliz|haribo|chicle|nube|golosina|sugus|gel energético|gel deportivo|mochi|lokum|halva|dulces indios|dulces japoneses|cocadas'],
  ['Lollipop', 'main', 'piruleta|chupa chups|chupachups'],
  ['IceCreamBowl', 'main', 'mcflurry|sundae|copa de helado|tarrina|banana split|bingsu|halo-halo'],
  ['IceCreamCone', 'main', 'helado|cornetto|cucurucho|magnum|sorbete|gelato'],
  ['Popsicle', 'main', 'polo|calippo|frigo|flash'],
  ['Dessert', 'main', 'flan|natillas|crema catalana|arroz con leche|mousse|postre|gelatina|torrija|crepe|gofre|waffle|tortita|pancake|cuajada|leche frita|compota|panna cotta|crumble|strudel|natilla|kheer|tang yuan|hotteok|trifle|pavlova|eton mess|kaiserschmarrn|mel i mató|bienmesabe|blini|syrniki'],
  ['Popcorn', 'main', 'palomitas|snack|aperitivo|pringles|lays|ruffles|doritos|cheetos|risi|kikos|gusanitos|chips|cortezas|nachos|totopos|matutano|grefusa|chilaquiles'],
  ['Nut', 'main', 'fruto seco|almendra|nuez|cacahuete|pistacho|avellana|anacardo|pipa|castaña|coco|dátil|semilla|chía|sésamo|piñón|nueces|macadamia'],
  ['jar', 'main', 'mermelada|miel|nutella|nocilla|crema de cacahuete|mantequilla de cacahuete|tahini|paté|mantequilla|margarina|confitura|crema de avellanas|crema de cacao|foie|sirope|dulce de membrillo|crema para untar|azúcar|edulcorante|sacarina|ghee|potito|rillettes|morteruelo'],

  // ───────────── pan, bocadillos y comida rápida ─────────────
  ['bread', 'main', 'pan|tostada|biscote|pan de molde|colines|regañá|pico|bimbo|hogaza|panecillo|tosta|chapata|ciabatta|naan|roti canai|msemen|injera|pretzel|simit|mantou|arepa|kaya toast|crumpet|pão de queijo|pao de queijo|smørrebrød'],
  ['baguette', 'main', 'bocadillo|bocata|baguette|pepito|montadito|serranito|flauta|mollete|panini|entrepán|bagel|bikini|pincho|pintxo|sub|subway|bmt|bánh mì|banh mi|francesinha|bifana|choripán|completo chileno|vada pav|philly cheesesteak|lobster roll'],
  ['Sandwich', 'main', 'sándwich|mixto|club|croque|grilled cheese'],
  ['wrap', 'main', 'wrap|burrito|fajita|quesadilla|chimichanga|enchilada|taco|twister|mexicana|mexicano|tinga|cochinita|carnitas|birria|taquito|jianbing|dosa|banh xeo|tamal|pupusa|tlayuda|sopes|baleadas|gözleme'],
  ['kebab', 'main', 'kebab|kebap|döner|durum|dürüm|shawarma|gyros|souvlaki|kofta|shashlik|satay|anticuchos|suya'],
  ['Pizza', 'main', 'pizza|calzone|telepizza|pizza hut|papa johns|dominos|focaccia|lahmacun|pide|manakish|piadina|khachapuri|pissaladière|quiche'],
  ['Hamburger', 'main', 'hamburguesa|hamburger|burger|whopper|big mac|bigmac|big tasty|big king|cheeseburger|mcroyal|cuarto de libra|mcpollo|long chicken|mcchicken|chicken royale|filet-o-fish|filet o fish|mcfish|mcmuffin|mcdouble|happy meal|cajita feliz|smash|angus|sloppy joe'],
  ['fries', 'main', 'patatas fritas|papas fritas|patatas bravas|bravas|french fries|patatas deluxe|wedges|patatas gajo|tater tots|salchipapas|poutine'],
  ['sausage', 'main', 'chorizo|salchicha|salchichón|longaniza|butifarra|morcilla|fuet|sobrasada|frankfurt|perrito|hot dog|chistorra|bratwurst|morcón|salami|pepperoni|embutido|currywurst|merguez|bangers and mash|haggis|zorza|corn dog'],

  // ───────────── carnes, pescados y mariscos ─────────────
  ['Drumstick', 'main', 'pollo|pavo|muslo|pechuga|alita|nugget|mcnugget|kfc|crispy|tender|finger|codorniz|capón|gallina|pato|wing|zinger|popcorn chicken|karaage|coxinha|coq au vin'],
  ['Beef', 'main', 'ternera|vaca|vacuno|filete|bistec|chuletón|entrecot|solomillo|carne|albóndigas|cachopo|escalope|buey|tartar|steak|carpaccio|san jacobo|carrillera|rabo de toro|callos|hígado|lengua|riñones|osobuco|cecina|pastel de carne|bulgogi|rendang|bobotie|kibbeh|köttbullar|brisket|osso buco|saltimbocca|sauerbraten|vitello tonnato|beef wellington|shepherd\'s pie|meat pie|tourtière|casquería|ropa vieja|cordon bleu'],
  ['meat', 'main', 'cerdo|costilla|lomo|cordero|cochinillo|secreto|presa|pluma|carrillada|chuleta|cabrito|conejo|asado|lechazo|paletilla|torrezno|manita|pulled pork|codillo|jarrete|pata de cerdo|jabalí|ciervo|venado|corzo|caballo|carne de caza|tonkatsu|sisig|raxo|flamenquín|sunday roast|pork pie'],
  ['Ham', 'main', 'jamón|serrano|ibérico|bacon|beicon|panceta|fiambre|york|mortadela|chopped|lacón|charcutería'],
  ['Fish', 'main', 'pescado|merluza|salmón|atún|bacalao|dorada|lubina|trucha|rape|lenguado|emperador|pez espada|rodaballo|caballa|bonito|mero|besugo|pescadilla|panga|tilapia|ceviche|ventresca|mojama|surimi|palitos de cangrejo|ahumado|fish and chips|pastel de pescado|pastel de cabracho|anguila|angula|gula|hueva|unagi|bacalhau|pixín|all i pebre'],
  ['fish-bone', 'main', 'sardina|boquerón|anchoa|sardinilla|espeto|arenque|jurel|chanquetes|escabeche|gilda'],
  ['Shrimp', 'main', 'gamba|langostino|camarón|cigala|bogavante|langosta|marisco|mejillón|almeja|berberecho|navaja|ostra|vieira|calamar|chipirón|sepia|pulpo|cangrejo|centollo|nécora|percebe|zamburiña|txangurro|raba|carabinero|gambón|choco'],
  ['Egg', 'main', 'huevo|clara|yema|chawanmushi|scotch egg'],
  ['EggFried', 'main', 'huevo frito|huevos fritos|huevos rotos|huevos estrellados|huevos a la plancha|huevo a la plancha|tortilla|revuelto|huevos revueltos|huevo revuelto|huevos benedictinos|huevos al plato|huevos a la flamenca|omelette|huevos poché|huevo poché|huevos escalfados|huevo escalfado|tamagoyaki|shakshuka|menemen|zarangollo|desayuno inglés'],

  // ───────────── platos de cuchara, arroces y pastas ─────────────
  ['Soup', 'main', 'sopa|caldo|crema de|puré de|consomé|minestrone|vichyssoise|gazpacho|salmorejo|ajoblanco|bisque|porrusalda|tom yum|laksa|bak kut teh|samgyetang|pozole|sancocho|borscht|harira|bouillabaisse|clam chowder|sinigang|soto ayam|bakso|menudo'],
  ['CookingPot', 'main', 'cocido|estofado|guiso|fabada|potaje|olla|marmitako|caldereta|curry|chili|chilli|cazuela|pisto|lenteja|miga|gachas|ratatouille|tajín|goulash|caracol|dal|chana masala|palak paneer|chole bhature|pav bhaji|keema|hot pot|mole|bandeja paisa|feijoada|locro|moussaka|tajine|doro wat|mafé|moqueca|stroganoff|bigos|golabki|gulash|irish stew|cassoulet|adobo|pote gallego|gumbo|jambalaya'],
  ['bowl-chopsticks', 'main', 'fideo chino|fideo oriental|fideo de arroz|noodle|ramen|udon|pad thai|wok|soba|sushi|maki|nigiri|sashimi|gyoza|dumpling|dim sum|rollito|poke|bowl|bibimbap|kimchi|yakisoba|chop suey|tempura|katsu|onigiri|wonton|wantán|pho|bao|takoyaki|yakitori|donburi|tteokbokki|japchae|okonomiyaki|kimbap|naengmyeon|zhajiangmian|char kway teow|bun cha|lumpia|pancit|khinkali'],
  ['pasta', 'main', 'pasta|macarrón|espagueti|spaghetti|tallarín|lasaña|canelón|ravioli|tortellini|ñoqui|carbonara|boloñesa|penne|fusilli|tagliatelle|fideuá|fideo|cacio e pepe|mac and cheese|spätzle|käsespätzle|pierogi|manti'],
  ['rice', 'main', 'arroz|paella|risotto|moros y cristianos|pilaf|biryani|congee|nasi goreng|poha|khichdi|pabellón criollo|plov|jollof rice|koshari|mujaddara|arancini'],
  ['Wheat', 'main', 'cereal|avena|copo|muesli|granola|cuscús|quinoa|trigo|corn flakes|harina|gofio|mijo|bulgur|polenta|maíz|chocapic|special k|kellogg|seitán|upma|cachapa|elote|farofa|kasha|grits|overnight oats|oats'],
  ['bowl-spoon', 'main', 'yogur|skyr|kéfir|activia|danone|danet|actimel|porridge|requesón|queso batido|cottage|bol de fruta|acai bowl|pudding|petit suisse|danonino|quark|papilla|labneh|tzatziki'],
  ['cheese', 'main', 'queso|mozzarella|parmesano|feta|brie|camembert|cabrales|idiazábal|emmental|gouda|cheddar|manchego|philadelphia|quesitos|babybel|la vaca que ríe|halloumi|roquefort|gorgonzola|ricotta|mascarpone|burrata|fondue|raclette|paneer|tequeños|provoleta'],

  // ───────────── verduras, legumbres y fruta ─────────────
  ['Salad', 'main', 'ensalada|ensaladilla|césar|caprese|tabulé|coleslaw|crudités|esqueixada|pipirrana|xató|piriñaca|empedrat|som tam|larb|gado-gado|fattoush'],
  ['LeafyGreen', 'main', 'lechuga|espinaca|acelga|rúcula|canónigo|escarola|endibia|berro|kale|borraja|grelo|brote|achicoria|cogollo|spanakopita|dolmades'],
  ['tomato', 'main', 'tomate|pico de gallo'],
  ['potato', 'main', 'patata|papa|boniato|batata|rösti|croqueta|yuca|mandioca|tapioca|ñame|pakora|causa limeña|fufu|colcannon|tartiflette|gratin dauphinois|hash browns|atascaburras'],
  ['broccoli', 'main', 'brócoli|coliflor|verdura|judía verde|espárrago|alcachofa|berenjena|calabacín|calabaza|col|coles de bruselas|repollo|puerro|cebolla|pepino|guisante|ajo|remolacha|nabo|rábano|apio|hinojo|cardo|escalivada|tumbet|samfaina|menestra|vegetal|pastel de verduras|pepinillo|aloo gobi|imam bayildi|parmigiana|calçot|chucrut'],
  ['Carrot', 'main', 'zanahoria|chirivía'],
  ['pepper', 'main', 'pimiento|guindilla|chile|piquillo|jalapeño|piparra|padrón|morrón|pimentón'],
  ['mushroom', 'main', 'champiñón|seta|boletus|portobello|níscalo|rebozuelo|shiitake|hongo|colmenilla|morilla|girgola'],
  ['avocado', 'main', 'aguacate|guacamole'],
  ['Bean', 'main', 'legumbre|alubia|judía blanca|frijol|soja|edamame|hummus|humus|tofu|garbanzo|fabes|judión|tempeh|falafel|altramuz|haba|rajma|natto|ful medames|baked beans|acarajé|baba ganoush'],
  ['Apple', 'main', 'manzana|fruta|pera|melocotón|nectarina|albaricoque|ciruela|kiwi|mango|papaya|higo|granada|caqui|chirimoya|membrillo|macedonia|níspero|paraguayo|maracuyá|lichi|guayaba|orejón'],
  ['Banana', 'main', 'plátano|banana|banano|mofongo'],
  ['Citrus', 'main', 'naranja|mandarina|clementina|pomelo|satsuma|toronja|tangerina'],
  ['lemon', 'main', 'limón|lima|limonada'],
  ['Cherry', 'main', 'cereza|picota|guinda'],
  ['Grape', 'main', 'uva|pasas|sultanas|mosto'],
  ['strawberry', 'main', 'fresa|fresón|frambuesa|arándano|fruto rojo|mora|baya|zarzamora|grosella|açaí|acai|goji'],
  ['watermelon', 'main', 'sandía|melón'],
  ['pineapple', 'main', 'piña|ananás'],
  ['Amphora', 'main', 'aceite|aceituna|oliva|vinagre|aove|encurtido|banderilla'],

  // ───────────── bebidas con cuerpo (se cuentan como comida) ─────────────
  ['milkshake', 'main', 'batido|frappé|frappuccino|smoothie|shake|proteína|whey|horchata|granizado|licuado|malteada|colágeno|gainer'],

  // ───────────── bebidas ─────────────
  ['mug', 'drink', 'café con leche|colacao|cola cao|nesquik|chocolate caliente|chocolate a la taza|leche con cacao|capuchino|cappuccino|latte|moka|mocha|mocaccino|café bombón|cacaolat|chocolate con churros'],
  ['Coffee', 'drink', 'café|cortado|expreso|espresso|americano|carajillo|macchiato|nespresso|ristretto|descafeinado|cold brew|affogato|flat white'],
  ['teapot', 'drink', 'té|infusión|manzanilla|poleo|tila|rooibos|matcha|chai|mate|earl grey|kombucha|tisana|bubble tea|boba|thai tea'],
  ['Milk', 'drink', 'leche|bebida de avena|bebida de almendras|bebida de soja|bebida de arroz|bebida de coco|bebida vegetal|nata|pascual|puleva|lassi|ayran|yakult'],
  ['Beer', 'drink', 'cerveza|caña|birra|tercio|shandy|estrella|mahou|cruzcampo|san miguel|heineken|alhambra|voll damm|corona|budweiser|ipa|lager|amstel|moritz|damm|chela|litrona|botellín|michelada'],
  ['glass-champagne', 'drink', 'cava|champán|prosecco|espumoso|brut|mimosa|bellini|spritz'],
  ['Wine', 'drink', 'vino|tinto|rosado|sangría|rioja|ribera|verdejo|albariño|sidra|vermut|calimocho|rebujito|jerez|fino|pedro ximénez|moscatel|txakolí|clarete|mistela'],
  ['glass-gin', 'drink', 'gin|ginebra|ron|cubata|cuba libre|whisky|vodka|licor|brandy|coñac|tequila|anís|aguardiente|orujo|pacharán|chupito|copa|combinado|bourbon|baileys|jagermeister|amaretto|sambuca|grappa|mezcal|pisco|sake'],
  ['Martini', 'drink', 'cóctel|cocktail|mojito|margarita|daiquiri|piña colada|aperol|campari|negroni|martini|manhattan|cosmopolitan|caipirinha|bloody mary|mai tai|moscow mule|old fashioned|sex on the beach|long island|queimada|limoncello'],
  ['CanSoda', 'drink', 'red bull|redbull|monster|burn|bebida energética|energy|rockstar|powerade|gatorade|aquarius|isotónica'],
  ['CupSoda', 'drink', 'refresco|cola|coca cola|pepsi|fanta|sprite|7up|seven up|tónica|gaseosa|nestea|bebida|kas|trina|mirinda|schweppes|bitter|ginger ale'],
  ['Citrus', 'drink', 'zumo|jugo|naranjada'],
  ['GlassWater', 'drink', 'agua|soda|sifón|vichy|seltz'],

  // ───────────── condimentos ─────────────
  ['bottle', 'side', 'salsa|ketchup|kétchup|mayonesa|mostaza|alioli|pesto|vinagreta|aderezo|bechamel|sofrito|mojo|tabasco|sriracha|romesco|chimichurri|ragú|chutney'],
  ['salt', 'side', 'sal|pimienta|especia|orégano|tomillo|romero|perejil|albahaca|comino|cúrcuma|canela|laurel|azafrán|vainilla|jengibre|condimento'],
];

/**
 * Ilustraciones más finas que el tipo general (`RULES`): un gofre no es «un postre» ni un mango «una fruta cualquiera». Cada una dice el archivo de la ilustración (de `food-photos/`: ver
 * `scripts/vendor-food-icons.mjs`), el icono de línea de repuesto (de `RULES`) y las palabras que la señalan. Van ANTES que las generales: con la misma posición y la misma longitud gana la
 * primera. Si el archivo de la ilustración no está empaquetado, la miniatura usa la del tipo general (`mealArt` lo resuelve con `hasArt`).
 */
const DETAIL: ReadonlyArray<readonly [art: string, icon: string, role: Role, words: string]> = [
  // masas, panes y dulces
  ['pancakes', 'Dessert', 'main', 'pancake|tortitas americanas|tortita americana|hotcakes|crepe|crêpe|crepes'],
  ['waffle', 'Dessert', 'main', 'gofre|waffle'],
  ['bagel', 'bread', 'main', 'bagel'],
  ['pretzel', 'bread', 'main', 'pretzel|brezel|simit'],
  ['flatbread', 'bread', 'main', 'naan|pita|chapati|roti|roti canai|msemen|injera|arepa|cachapa|tortilla de maíz|tortilla de trigo'],
  ['tamale', 'wrap', 'main', 'tamal|tamales'],
  ['falafel', 'Bean', 'main', 'falafel'],
  ['fondue', 'cheese', 'main', 'fondue|raclette'],
  ['dumpling', 'bowl-chopsticks', 'main', 'gyoza|dumpling|dim sum|jiaozi|wonton|mandu|momo|pierogi'],
  ['pie', 'CakeSlice', 'main', 'pie|tarta de manzana|tarta de calabaza|pumpkin pie|tarta de nueces|meat pie|pastel de carne'],
  ['dango', 'Dessert', 'main', 'dango|mochi|mochis|daifuku'],
  ['moon_cake', 'Cookie', 'main', 'mooncake|pastel de luna|dan tat'],
  ['fortune_cookie', 'Cookie', 'main', 'galleta de la fortuna|fortune cookie'],
  ['rice_cracker', 'Cookie', 'main', 'tortitas de arroz|tortita de arroz|rice cake|senbei'],
  // otras cocinas
  ['sushi', 'bowl-chopsticks', 'main', 'sushi|maki|nigiri|temaki|uramaki|sashimi|chirashi'],
  ['bento_box', 'bowl-chopsticks', 'main', 'bento|donburi|poke|poke bowl'],
  ['takeout_box', 'Utensils', 'main', 'para llevar|take away|takeaway|comida china|chop suey'],
  ['rice_ball', 'rice', 'main', 'onigiri|bola de arroz|arancini'],
  ['curry_rice', 'CookingPot', 'main', 'curry|biryani|tikka masala|korma|katsu curry|dal|masala|khichdi'],
  ['fish_cake_with_swirl', 'Fish', 'main', 'surimi|kamaboko|narutomaki|gulas|palitos de cangrejo'],
  ['oden', 'CookingPot', 'main', 'oden|hot pot|hotpot|shabu'],
  // pescado, marisco y aves
  ['lobster', 'Shrimp', 'main', 'langosta|bogavante|cigala|cigalas|lobster roll'],
  ['crab', 'Shrimp', 'main', 'cangrejo|centollo|nécora|txangurro|buey de mar'],
  ['squid', 'Shrimp', 'main', 'calamar|calamares|chipirón|chipirones|sepia|rabas'],
  ['oyster', 'Shrimp', 'main', 'ostra|ostras'],
  ['octopus', 'Shrimp', 'main', 'pulpo|pulpo a la gallega|pulpo a feira'],
  ['fried_shrimp', 'Shrimp', 'main', 'gambas rebozadas|gambas fritas|langostinos rebozados|tempura|gabardina'],
  ['turkey', 'Drumstick', 'main', 'pavo asado|pavo relleno|pavo'],
  ['duck', 'Drumstick', 'main', 'pato|magret|confit de pato|pato laqueado'],
  // fruta y verdura
  ['green_apple', 'Apple', 'main', 'manzana verde|manzanas verdes|granny smith'],
  ['kiwi_fruit', 'Apple', 'main', 'kiwi|kiwis'],
  ['peach', 'Apple', 'main', 'melocotón|melocotones|nectarina|nectarinas|paraguayo|paraguayos'],
  ['pear', 'Apple', 'main', 'pera|peras'],
  ['melon', 'watermelon', 'main', 'melón|melones|cantalupo'],
  ['mango', 'Apple', 'main', 'mango|mangos'],
  ['blueberries', 'strawberry', 'main', 'arándano|arándanos|mora|moras|frutos del bosque|frutos rojos|bayas'],
  ['eggplant', 'broccoli', 'main', 'berenjena|berenjenas'],
  ['garlic', 'broccoli', 'main', 'ajo|ajos'],
  ['onion', 'broccoli', 'main', 'cebolla|cebollas|cebolleta|cebolletas'],
  ['ginger_root', 'salt', 'side', 'jengibre'],
  ['pea_pod', 'Bean', 'main', 'guisante|guisantes|haba|habas|judía verde|judías verdes|edamame|ejotes'],
  ['chestnut', 'Nut', 'main', 'castaña|castañas|marron glacé'],
  ['coconut', 'Nut', 'main', 'coco|coco rallado'],
  ['cucumber', 'broccoli', 'main', 'pepino|pepinos|pepinillo|pepinillos'],
  ['ear_of_corn', 'Wheat', 'main', 'mazorca|elote|choclo|maíz dulce|maíz'],
  ['hot_pepper', 'pepper', 'main', 'guindilla|guindillas|chile|chiles|chili|jalapeño|jalapeños|piparra|piparras'],
  ['roasted_sweet_potato', 'potato', 'main', 'boniato|boniatos|batata|batatas|camote'],
  // despensa y bebidas
  ['butter', 'jar', 'main', 'mantequilla|margarina'],
  ['mate', 'teapot', 'drink', 'mate|yerba mate'],
  ['teacup_without_handle', 'teapot', 'drink', 'té verde|matcha|sencha|té negro|té con leche'],
  ['beverage_box', 'Milk', 'drink', 'bebida de avena|bebida de soja|bebida de almendras|bebida de arroz|bebida de coco|bebida vegetal|zumo envasado|brick'],
  ['tropical_drink', 'Martini', 'drink', 'piña colada|mai tai|caipirinha|daiquiri|cóctel tropical'],
  ['sake', 'glass-gin', 'drink', 'sake|soju'],
  ['baby_bottle', 'Milk', 'drink', 'biberón|leche de fórmula|leche infantil'],
  ['ice', 'Popsicle', 'side', 'hielo|granizado'],
];

const MATCHERS = compileRules<{ icon: string; art: string }>([
  ...DETAIL.map(([art, icon, role, words]) => ({ value: { icon, art }, role, words })),
  ...RULES.map(([icon, role, words]) => ({ value: { icon, art: icon }, role, words })),
]);

/** El nombre del icono (de `icons.tsx`, `icon-custom.ts` o `icon-set.ts`) que mejor dice qué es esta comida; `Utensils` si no se reconoce nada. */
export function mealIconName(name: string): string {
  return bestRule(MATCHERS, name)?.icon ?? 'Utensils';
}

/** Qué ilustración y qué icono de línea de repuesto lleva una comida: la ilustración fina si la hay (`DETAIL`) y, si no, la del tipo general. */
export function mealArt(name: string): { icon: string; art: string } {
  return bestRule(MATCHERS, name) ?? { icon: 'Utensils', art: 'Utensils' };
}

/** Las ilustraciones finas que puede dar `mealArt` (para comprobar que cada una se usa y tiene un icono de repuesto que existe). */
export const DETAIL_ARTS: ReadonlyArray<{ art: string; icon: string }> = DETAIL.map(([art, icon]) => ({ art, icon }));

/** Todos los iconos que puede dar `mealIconName` (para comprobar que existen). */
export const MEAL_ICON_NAMES: readonly string[] = [...new Set([...RULES.map(([icon]) => icon), 'Utensils'])];
