import type { JSX, SVGAttributes } from 'preact';
import {
  Activity,
  Amphora,
  Apple,
  Banana,
  Bean,
  Beef,
  Beer,
  Blend,
  Cake,
  CakeSlice,
  CanSoda,
  Candy,
  Carrot,
  ChefHat,
  Slice,
  Cherry,
  Citrus,
  Coffee,
  CookingPot,
  Cookie,
  Croissant,
  CupSoda,
  Cupcake,
  Dessert,
  Donut,
  Drumstick,
  Egg,
  EggFried,
  Fish,
  GlassWater,
  Grape,
  Ham,
  Hamburger,
  IceCreamBowl,
  IceCreamCone,
  LeafyGreen,
  Lollipop,
  Martini,
  Milk,
  Nut,
  Pizza,
  Popcorn,
  Popsicle,
  Salad,
  Sandwich,
  Shrimp,
  Soup,
  Wheat,
  Wine,

  BatteryMedium,
  Bluetooth,
  BluetoothConnected,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Copy,
  Download,
  Droplet,
  Droplets,
  Footprints,
  GripVertical,
  HeartPulse,
  House,
  Lightbulb,
  ImagePlus,
  Info,
  Calculator,
  MessageSquareText,
  Mic,
  Moon,
  Pause,
  Pencil,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Ruler,
  Scale,
  ScanBarcode,
  Share2,
  ShoppingBasket,
  SlidersHorizontal,
  SportShoe,
  Square,
  Target,
  Timer,
  Trash2,
  TriangleAlert,
  Unlink,
  Upload,
  Utensils,
  X,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  LocateFixed,
  MapPin,
  Navigation,
  Search,
  Undo2,
  Volume2,
  VolumeX,
  RotateCw,
} from 'lucide-preact';
import { CUSTOM_ICONS } from './icon-custom';
import { TABLER_ICONS, type IconNode } from './icon-set';

/**
 * Dos familias con la misma rejilla (24 px, trazo de 2, extremos redondos), que se distinguen por el nombre:
 * - PascalCase: lucide. Las pestañas, la actividad (Footprints), el sueño (Moon) y el ritmo cardiaco (HeartPulse), más los
 *   iconos de interfaz (flechas, cerrar, aceptar…).
 * - minúsculas con guiones: Tabler (copiado por `scripts/vendor-icons.mjs`) y los dibujados aquí (`icon-custom.ts`): los
 *   deportes y las cifras (calorías, meta, distancia…).
 */
const LUCIDE = {
  Activity,
  Amphora,
  Apple,
  Banana,
  Bean,
  Beef,
  Beer,
  Cake,
  CakeSlice,
  CanSoda,
  Candy,
  Carrot,
  ChefHat,
  Slice,
  Blend,
  Cherry,
  Citrus,
  Coffee,
  CookingPot,
  Cookie,
  Croissant,
  CupSoda,
  Cupcake,
  Dessert,
  Donut,
  Drumstick,
  Egg,
  EggFried,
  Fish,
  GlassWater,
  Grape,
  Ham,
  Hamburger,
  IceCreamBowl,
  IceCreamCone,
  LeafyGreen,
  Lollipop,
  Martini,
  Milk,
  Nut,
  Pizza,
  Popcorn,
  Popsicle,
  Salad,
  Sandwich,
  Shrimp,
  Soup,
  Wheat,
  Wine,

  BatteryMedium,
  Bluetooth,
  BluetoothConnected,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Copy,
  Download,
  Droplet,
  Droplets,
  Footprints,
  GripVertical,
  HeartPulse,
  House,
  Lightbulb,
  ImagePlus,
  Info,
  Calculator,
  MessageSquareText,
  Mic,
  Moon,
  Pause,
  Pencil,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Ruler,
  Scale,
  ScanBarcode,
  Share2,
  ShoppingBasket,
  SlidersHorizontal,
  SportShoe,
  Square,
  Target,
  Timer,
  Trash2,
  TriangleAlert,
  Unlink,
  Upload,
  Utensils,
  X,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  LocateFixed,
  MapPin,
  Navigation,
  Search,
  Undo2,
  Volume2,
  VolumeX,
  RotateCw,
} as const;

export type IconName = keyof typeof LUCIDE;

interface IconProps {
  name: string;
  size?: number;
  class?: string;
  strokeWidth?: number;
}

function drawing(name: string): IconNode | undefined {
  return CUSTOM_ICONS[name] ?? TABLER_ICONS[name];
}

/** ¿Existe un icono con este nombre? (si no, `Icon` dibuja uno genérico y el fallo pasaría desapercibido). */
export function hasIcon(name: string): boolean {
  return drawing(name) !== undefined || name in LUCIDE;
}

/** Icono por nombre (los deportes lo traen en su catálogo). Un nombre desconocido no rompe la pantalla. */
export function Icon({ name, size = 20, class: className, strokeWidth = 2 }: IconProps): JSX.Element {
  const nodes = drawing(name);
  if (nodes) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width={strokeWidth}
        stroke-linecap="round"
        stroke-linejoin="round"
        class={className}
        aria-hidden="true"
      >
        {nodes.map(([tag, attrs], i) => {
          const Tag = tag as 'path'; // path, circle, rect…: el tipo solo hace falta para que compile
          return <Tag key={i} {...(attrs as SVGAttributes<SVGPathElement>)} />;
        })}
      </svg>
    );
  }
  const Component = (LUCIDE as Record<string, (typeof LUCIDE)[IconName]>)[name] ?? Activity;
  return <Component size={size} strokeWidth={strokeWidth} class={className} aria-hidden="true" />;
}

/**
 * El anillo (R99): una banda gruesa vista en perspectiva, con su abertura y un sensor, sin piedra, para que no parezca una joya.
 * Es el acceso rápido al anillo (arriba a la derecha), la insignia «Medido» y la cabecera de la hoja del anillo. Misma rejilla que
 * el resto (24 px, trazo de 2, extremos redondos). Por debajo de 20 px se dibuja la versión simple (sin pared interior ni sensor y
 * con el trazo algo más grueso): a ese tamaño los detalles se funden y la abertura dejaría de verse.
 */
export function RingIcon({ size = 26, class: className }: { size?: number; class?: string }): JSX.Element {
  const small = size < 20;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={small ? 2.2 : 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
      aria-hidden="true"
    >
      {/* La banda: el contorno de dos elipses unidas por sus tangentes (la cara delantera y la trasera). */}
      <path d="M2.35 14.98A4.58 9.76 -122 0 1 18.91 4.63L21.65 9.02A4.58 9.76 -122 0 1 5.09 19.37Z" />
      {/* La abertura, algo mayor en la versión simple. */}
      <path
        d={
          small
            ? 'M12.53 12.84A3.58 7.63 -122 1 0 8.73 6.76A3.58 7.63 -122 1 0 12.53 12.84Z'
            : 'M12.47 12.76A3.49 7.43 -122 1 0 8.78 6.85A3.49 7.43 -122 1 0 12.47 12.76Z'
        }
      />
      {/* Pared interior que se ve a través de la abertura, y el sensor de la banda. */}
      {!small && <path d="M7.79 14.63A3.49 7.43 -122 0 1 16.21 9.37" />}
      {!small && <path d="M11.85 16.85h.01" />}
    </svg>
  );
}

/**
 * Los dispositivos (el menú de arriba a la derecha): el símbolo de Bluetooth conectado, de lucide, porque el anillo y la báscula son lo que se empareja y se conecta por ahí. Sustituyó al
 * anillo solo como icono de ese botón cuando el menú pasó a ser de todos los dispositivos; `RingIcon` sigue dibujando el anillo y es el que va en la cabecera del anillo. Un dibujo propio
 * (un anillo junto a una báscula) se probó y no quedaba bien a ese tamaño.
 */
export function DevicesIcon({ size = 26, class: className }: { size?: number; class?: string }): JSX.Element {
  return <Icon name="BluetoothConnected" size={size} class={className} />;
}
