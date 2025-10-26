export interface ProfessionPreset {
  id: string;
  name: string;
  icon: string;
  description: string;
  useCase: string;
  improvements: string[];
  constraints: string[];
  background: string[];
  aspects: string[];
  style: string[];
  styleHints: string[];
  outputSize: string;
  questions: Question[];
}

export interface Question {
  id: string;
  label: string;
  type: 'select' | 'textarea';
  options?: string[];
  placeholder?: string;
  required?: boolean;
}

export const professionPresets: ProfessionPreset[] = [
  {
    id: 'restaurant',
    name: 'Restaurant',
    icon: 'fas fa-utensils',
    description: 'Food photography and restaurant imagery',
    useCase: 'Restaurant marketing and menu photography',
    improvements: ['Enhanced food colors', 'Better lighting', 'Appetizing appearance', 'Professional presentation'],
    constraints: ['Food safety compliance', 'Natural appearance', 'No artificial enhancement'],
    background: ['Clean white', 'Subtle wood texture', 'Restaurant ambiance', 'Blurred dining area'],
    aspects: ['Square (1:1)', 'Landscape (16:9)', 'Portrait (4:5)'],
    style: ['Professional', 'Appetizing', 'Clean', 'Vibrant'],
    styleHints: ['Warm lighting', 'Enhanced saturation', 'Sharp details', 'Minimal shadows'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'primaryUse',
        label: "What's the primary use?",
        type: 'select',
        options: ['Menu photography', 'Social media posts', 'Website gallery', 'Marketing materials'],
        required: true
      },
      {
        id: 'foodType',
        label: 'Type of cuisine',
        type: 'select',
        options: ['Fine dining', 'Casual dining', 'Fast food', 'Bakery items', 'Beverages']
      },
      {
        id: 'style',
        label: 'Desired style',
        type: 'select',
        options: ['Professional', 'Rustic', 'Modern', 'Traditional']
      },
      {
        id: 'background',
        label: 'Background preference',
        type: 'select',
        options: ['Keep original', 'Clean white', 'Wood texture', 'Restaurant setting']
      },
      {
        id: 'additional',
        label: 'Additional requirements',
        type: 'textarea',
        placeholder: 'Any specific requests for your food photography...'
      }
    ]
  },
  {
    id: 'bakery',
    name: 'Bakery',
    icon: 'fas fa-birthday-cake',
    description: 'Bakery and pastry photography',
    useCase: 'Bakery product showcasing and marketing',
    improvements: ['Golden crust enhancement', 'Texture details', 'Appetizing colors', 'Professional lighting'],
    constraints: ['Natural food appearance', 'No over-saturation', 'Realistic textures'],
    background: ['Rustic wood', 'Clean white', 'Bakery counter', 'Vintage setting'],
    aspects: ['Square (1:1)', 'Portrait (4:5)', 'Landscape (16:9)'],
    style: ['Artisanal', 'Traditional', 'Modern', 'Rustic'],
    styleHints: ['Warm tones', 'Detailed textures', 'Natural lighting', 'Cozy atmosphere'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'primaryUse',
        label: "What's the primary use?",
        type: 'select',
        options: ['Product catalog', 'Social media', 'Website display', 'Marketing flyers'],
        required: true
      },
      {
        id: 'productType',
        label: 'Type of baked goods',
        type: 'select',
        options: ['Bread', 'Cakes', 'Pastries', 'Cookies', 'Specialty items']
      },
      {
        id: 'style',
        label: 'Bakery style',
        type: 'select',
        options: ['Artisanal', 'Traditional', 'Modern', 'French patisserie']
      }
    ]
  },
  {
    id: 'trades',
    name: 'Trades',
    icon: 'fas fa-tools',
    description: 'Tradesperson and construction work',
    useCase: 'Showcasing craftsmanship and completed projects',
    improvements: ['Work quality highlight', 'Professional appearance', 'Clear details', 'Before/after contrast'],
    constraints: ['Accurate representation', 'Safety compliance', 'Professional standards'],
    background: ['Work environment', 'Clean backdrop', 'On-site location', 'Workshop setting'],
    aspects: ['Landscape (16:9)', 'Square (1:1)', 'Portrait (4:5)'],
    style: ['Professional', 'Documentary', 'Before/After', 'Portfolio'],
    styleHints: ['Clear lighting', 'Sharp details', 'Neutral tones', 'Professional finish'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'tradeType',
        label: 'Type of trade work',
        type: 'select',
        options: ['Plumbing', 'Electrical', 'Carpentry', 'Painting', 'General construction'],
        required: true
      },
      {
        id: 'purpose',
        label: 'Photo purpose',
        type: 'select',
        options: ['Portfolio showcase', 'Before/after comparison', 'Process documentation', 'Client presentation']
      }
    ]
  },
  {
    id: 'realestate',
    name: 'Real Estate',
    icon: 'fas fa-home',
    description: 'Property and real estate photography',
    useCase: 'Property listings and real estate marketing',
    improvements: ['Bright interiors', 'Welcoming atmosphere', 'Space enhancement', 'Curb appeal'],
    constraints: ['Accurate representation', 'No misleading enhancements', 'Natural lighting'],
    background: ['Property setting', 'Sky enhancement', 'Landscape improvement', 'Interior ambiance'],
    aspects: ['Landscape (16:9)', 'Square (1:1)', 'Panoramic'],
    style: ['Professional', 'Luxury', 'Welcoming', 'Bright'],
    styleHints: ['HDR effect', 'Bright exposure', 'Color correction', 'Symmetry enhancement'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'propertyType',
        label: 'Property type',
        type: 'select',
        options: ['Residential house', 'Apartment', 'Commercial', 'Land/vacant lot'],
        required: true
      },
      {
        id: 'photoType',
        label: 'Photo type',
        type: 'select',
        options: ['Exterior front', 'Interior rooms', 'Backyard/outdoor', 'Aerial view']
      },
      {
        id: 'enhancement',
        label: 'Enhancement focus',
        type: 'select',
        options: ['Brighten space', 'Sky replacement', 'Color correction', 'Perspective fix']
      }
    ]
  },
  {
    id: 'automotive',
    name: 'Car Dealer',
    icon: 'fas fa-car',
    description: 'Automotive and vehicle photography',
    useCase: 'Vehicle sales and automotive marketing',
    improvements: ['Paint finish enhancement', 'Reflection perfection', 'Detail clarity', 'Professional presentation'],
    constraints: ['Accurate vehicle representation', 'No false modifications', 'Realistic colors'],
    background: ['Showroom', 'Clean backdrop', 'Outdoor setting', 'Studio environment'],
    aspects: ['Landscape (16:9)', 'Square (1:1)', 'Panoramic'],
    style: ['Professional', 'Luxury', 'Sport', 'Classic'],
    styleHints: ['Enhanced reflections', 'Paint depth', 'Chrome polish', 'Dynamic angles'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'vehicleType',
        label: 'Vehicle type',
        type: 'select',
        options: ['Car', 'SUV/Truck', 'Motorcycle', 'Commercial vehicle'],
        required: true
      },
      {
        id: 'angle',
        label: 'Photo angle',
        type: 'select',
        options: ['Front 3/4 view', 'Side profile', 'Rear view', 'Interior']
      },
      {
        id: 'setting',
        label: 'Setting preference',
        type: 'select',
        options: ['Showroom', 'Outdoor lot', 'Studio backdrop', 'Natural environment']
      }
    ]
  },
  {
    id: 'construction',
    name: 'Construction',
    icon: 'fas fa-hard-hat',
    description: 'Construction and building projects',
    useCase: 'Project documentation and progress tracking',
    improvements: ['Site clarity', 'Progress documentation', 'Safety compliance', 'Professional presentation'],
    constraints: ['Accurate progress representation', 'Safety visibility', 'Clear documentation'],
    background: ['Construction site', 'Progress context', 'Before/after', 'Timeline documentation'],
    aspects: ['Landscape (16:9)', 'Square (1:1)', 'Panoramic'],
    style: ['Documentary', 'Professional', 'Progress', 'Aerial'],
    styleHints: ['Clear visibility', 'Contrast enhancement', 'Detail focus', 'Environmental context'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'projectStage',
        label: 'Project stage',
        type: 'select',
        options: ['Site preparation', 'Foundation', 'Framing', 'Completion'],
        required: true
      },
      {
        id: 'purpose',
        label: 'Documentation purpose',
        type: 'select',
        options: ['Progress tracking', 'Client updates', 'Portfolio', 'Compliance']
      }
    ]
  },
  {
    id: 'beauty',
    name: 'Hair & Nails',
    icon: 'fas fa-cut',
    description: 'Beauty and salon services',
    useCase: 'Beauty service showcasing and client portfolios',
    improvements: ['Color enhancement', 'Detail clarity', 'Professional lighting', 'Texture definition'],
    constraints: ['Natural skin tones', 'Realistic results', 'Client privacy'],
    background: ['Salon setting', 'Clean backdrop', 'Professional environment', 'Neutral tones'],
    aspects: ['Square (1:1)', 'Portrait (4:5)', 'Close-up'],
    style: ['Professional', 'Beauty', 'Before/After', 'Portfolio'],
    styleHints: ['Soft lighting', 'Color accuracy', 'Detail enhancement', 'Professional finish'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'serviceType',
        label: 'Service type',
        type: 'select',
        options: ['Hair styling', 'Hair coloring', 'Nail art', 'Manicure/Pedicure'],
        required: true
      },
      {
        id: 'purpose',
        label: 'Photo purpose',
        type: 'select',
        options: ['Portfolio showcase', 'Before/after', 'Social media', 'Marketing']
      }
    ]
  },
  {
    id: 'artist',
    name: 'Artist',
    icon: 'fas fa-palette',
    description: 'Artwork and creative photography',
    useCase: 'Art documentation and portfolio presentation',
    improvements: ['Color accuracy', 'Texture detail', 'Lighting enhancement', 'Professional presentation'],
    constraints: ['Color fidelity', 'Accurate representation', 'No artistic alteration'],
    background: ['Neutral backdrop', 'Gallery setting', 'Studio environment', 'Clean presentation'],
    aspects: ['Square (1:1)', 'Original ratio', 'Portrait (4:5)'],
    style: ['Professional', 'Gallery', 'Portfolio', 'Documentation'],
    styleHints: ['Accurate colors', 'Even lighting', 'Sharp details', 'Neutral presentation'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'artworkType',
        label: 'Artwork type',
        type: 'select',
        options: ['Painting', 'Drawing', 'Sculpture', 'Mixed media'],
        required: true
      },
      {
        id: 'purpose',
        label: 'Documentation purpose',
        type: 'select',
        options: ['Portfolio', 'Gallery submission', 'Sale listing', 'Archive']
      }
    ]
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    icon: 'fab fa-linkedin',
    description: 'Professional headshots and portraits',
    useCase: 'Professional networking and career profiles',
    improvements: ['Professional appearance', 'Lighting enhancement', 'Background cleanup', 'Confidence boost'],
    constraints: ['Professional standards', 'Realistic representation', 'Appropriate attire'],
    background: ['Professional backdrop', 'Office setting', 'Clean white', 'Subtle gradient'],
    aspects: ['Square (1:1)', 'Portrait (4:5)', 'Headshot ratio'],
    style: ['Professional', 'Corporate', 'Approachable', 'Confident'],
    styleHints: ['Professional lighting', 'Clean background', 'Confident expression', 'Business appropriate'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'industry',
        label: 'Industry/Field',
        type: 'select',
        options: ['Corporate/Business', 'Technology', 'Healthcare', 'Creative', 'Finance'],
        required: true
      },
      {
        id: 'tone',
        label: 'Professional tone',
        type: 'select',
        options: ['Corporate formal', 'Business casual', 'Creative professional', 'Approachable']
      }
    ]
  },
  {
    id: 'ecommerce',
    name: 'E-commerce',
    icon: 'fas fa-shopping-cart',
    description: 'Product photography for online sales',
    useCase: 'Online store and marketplace listings',
    improvements: ['Product clarity', 'Color accuracy', 'Detail enhancement', 'Professional presentation'],
    constraints: ['Accurate representation', 'Consistent lighting', 'No misleading enhancement'],
    background: ['Clean white', 'Transparent', 'Lifestyle setting', 'Product focus'],
    aspects: ['Square (1:1)', 'Portrait (4:5)', 'Product ratio'],
    style: ['Clean', 'Professional', 'Product focus', 'Commercial'],
    styleHints: ['Even lighting', 'White background', 'Product clarity', 'Shadow removal'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'productType',
        label: 'Product category',
        type: 'select',
        options: ['Fashion/Clothing', 'Electronics', 'Home goods', 'Beauty products', 'Jewelry'],
        required: true
      },
      {
        id: 'background',
        label: 'Background preference',
        type: 'select',
        options: ['Pure white', 'Transparent', 'Lifestyle scene', 'Branded backdrop']
      },
      {
        id: 'enhancement',
        label: 'Enhancement focus',
        type: 'select',
        options: ['Color accuracy', 'Detail sharpening', 'Shadow removal', 'Reflection addition']
      }
    ]
  },
  {
    id: 'generic',
    name: 'Generic',
    icon: 'fas fa-star',
    description: 'General purpose photo enhancement',
    useCase: 'General photo improvement and enhancement',
    improvements: ['Overall quality', 'Lighting enhancement', 'Color correction', 'Detail improvement'],
    constraints: ['Natural appearance', 'Balanced enhancement', 'Realistic results'],
    background: ['Original', 'Enhanced', 'Cleaned up', 'Improved'],
    aspects: ['Original', 'Square (1:1)', 'Landscape (16:9)', 'Portrait (4:5)'],
    style: ['Natural', 'Enhanced', 'Professional', 'Improved'],
    styleHints: ['Balanced enhancement', 'Natural colors', 'Improved clarity', 'Overall quality'],
    outputSize: '1024x1024',
    questions: [
      {
        id: 'purpose',
        label: 'Photo purpose',
        type: 'select',
        options: ['Personal use', 'Social media', 'Printing', 'General improvement'],
        required: true
      },
      {
        id: 'enhancement',
        label: 'Enhancement focus',
        type: 'select',
        options: ['Overall quality', 'Color correction', 'Lighting', 'Detail sharpening']
      },
      {
        id: 'style',
        label: 'Desired result',
        type: 'select',
        options: ['Natural enhancement', 'Vibrant colors', 'Professional look', 'Artistic effect']
      },
      {
        id: 'additional',
        label: 'Additional requirements',
        type: 'textarea',
        placeholder: 'Any specific requests for your photo enhancement...'
      }
    ]
  }
];

export function getPresetById(id: string): ProfessionPreset | undefined {
  return professionPresets.find(preset => preset.id === id);
}

export function composePrompt(preset: ProfessionPreset, answers: Record<string, string>): string {
  const additionalContext = Object.entries(answers)
    .filter(([key, value]) => value && value.trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join(' | ');

  return `Enhance this image for ${preset.useCase}. 
    
Improvements needed: ${preset.improvements.join(', ')}.
Constraints: ${preset.constraints.join(', ')}.
Background: ${preset.background.join(' or ')}.
Aspect ratio: ${preset.aspects.includes('Original') ? 'keep original' : preset.aspects[0]}.
Style: ${preset.style.join(', ')}.
Style hints: ${preset.styleHints.join(', ')}.
Output size: ${preset.outputSize}.

${additionalContext ? `Additional context: ${additionalContext}` : ''}

Please enhance this image professionally while maintaining natural appearance and following the specified requirements.`;
}
