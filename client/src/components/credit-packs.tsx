import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getDeviceUserId } from "@/lib/user-storage";
import { loadStripe } from "@stripe/stripe-js";
import { withDevice } from "@/lib/withDevice";
import { apiFetch } from "@/lib/api";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || '');

interface CreditPack {
  credits: number;
  price: number;
  pricePerCredit: number;
  savings?: string;
  popular?: boolean;
}

const creditPacks: CreditPack[] = [
  {
    credits: 10,
    price: 10,
    pricePerCredit: 1.00,
  },
  {
    credits: 25,
    price: 20,
    pricePerCredit: 0.80,
    savings: 'Save 20%',
    popular: true,
  },
  {
    credits: 50,
    price: 30,
    pricePerCredit: 0.60,
    savings: 'Save 40%',
  }
];

export function CreditPacks() {
  const { toast } = useToast();

  const handleBuyCredits = async (pack: CreditPack) => {
    try {
      const deviceId = getDeviceUserId();
      
      // First get user to ensure they exist
  const userResponse = await apiFetch('/api/me', { ...withDevice(), credentials: "include" });
      
      if (!userResponse.ok) {
        throw new Error('Failed to get user information');
      }
      
      const userData = await userResponse.json();
      
      // Create checkout session
      const response = await apiFetch('/api/checkout/session', withDevice({
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          credits: pack.credits,
          userId: userData.user.id
        }),
      }));

      if (!response.ok) {
        throw new Error('Failed to create checkout session');
      }

      const { url } = await response.json();
      
      // Redirect to Stripe Checkout
      window.location.href = url;
    } catch (error: any) {
      toast({
        title: "Payment Error",
        description: error.message || "Failed to initiate payment",
        variant: "destructive"
      });
    }
  };

  return (
    <section className="mb-12" id="credits-section" data-testid="credit-packs-section">
      <Card className="border border-border">
        <CardContent className="p-8">
          <h3 className="text-2xl font-semibold mb-6 text-center">Need More Credits?</h3>
          
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {creditPacks.map((pack, index) => (
              <Card 
                key={index}
                className={`text-center relative ${
                  pack.popular 
                    ? 'border-2 border-purple-500 shadow-lg shadow-purple-500/20' 
                    : 'border border-border'
                }`}
                data-testid={`credit-pack-${pack.credits}`}
              >
                {pack.popular && (
                  <div className="absolute -top-3 left-1/2 transform -translate-x-1/2 bg-gradient-to-r from-brand-primary to-brand-accent text-white px-4 py-1 rounded-full text-sm font-medium">
                    Most Popular
                  </div>
                )}
                
                <CardContent className={`p-6 ${pack.popular ? 'mt-2' : ''}`}>
                  <div className="mb-4">
                    <h4 className="text-lg font-semibold mb-2">
                      {pack.credits === 10 ? 'Starter Pack' : 
                       pack.credits === 25 ? 'Pro Pack' : 
                       'Business Pack'}
                    </h4>
                    <div className="text-3xl font-bold bg-gradient-to-r from-brand-primary to-brand-accent bg-clip-text text-transparent mb-1">
                      {pack.credits}
                    </div>
                    <div className="text-muted-foreground text-sm">credits</div>
                  </div>
                  
                  <div className="mb-6">
                    <div className="text-2xl font-bold">${pack.price} NZD</div>
                    <div className="text-muted-foreground text-sm">${pack.pricePerCredit.toFixed(2)} per credit</div>
                    {pack.savings && (
                      <div className="text-green-500 text-xs font-medium mt-1">{pack.savings}</div>
                    )}
                  </div>
                  
                  <Button 
                    type="button"
                    onClick={() => handleBuyCredits(pack)}
                    className="w-full bg-gradient-to-r from-brand-primary to-brand-accent hover:from-purple-600 hover:to-purple-700 text-white"
                    data-testid={`button-buy-${pack.credits}-credits`}
                  >
                    Buy Now
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
          
          <div className="text-center mt-8">
            <p className="text-muted-foreground text-sm">
              <svg className="inline w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M10,17L6,13L7.41,11.59L10,14.17L16.59,7.58L18,9L10,17Z"/>
              </svg>
              Secure payments powered by Stripe • Credits never expire
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
