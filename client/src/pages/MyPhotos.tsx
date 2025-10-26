// client/src/pages/MyPhotos.tsx
import { useState } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";

interface ImageHistory {
  id: string;
  createdAt: string;
  prompt: string;
  status: string;
  url: string | null;
}

interface MyImagesResponse {
  images: ImageHistory[];
}

export default function MyPhotos() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const [imageLoadErrors, setImageLoadErrors] = useState<Record<string, boolean>>({});

  // Use TanStack Query for data fetching with proper credentials
  const {
    data: imagesResponse,
    isLoading,
    error,
    refetch
  } = useQuery<MyImagesResponse>({
    queryKey: ["/api/my-images"],
    enabled: !!user, // Only fetch if user is authenticated
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    retry: (failureCount, error: any) => {
      // Don't retry on 401 (unauthorized)
      if (error?.status === 401) return false;
      return failureCount < 2;
    }
  });

  // Redirect if not authenticated
  if (!user) {
    setLocation("/");
    return null;
  }

  // Handle 401 errors
  if (error && (error as any)?.status === 401) {
    setLocation("/");
    return null;
  }

  const images = imagesResponse?.images || [];

  const handleDownload = async (imageUrl: string, imageId: string) => {
    try {
      // Use fetch to handle cross-origin signed URLs properly
      const response = await fetch(imageUrl, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch image');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `enhanced-photo-${imageId}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Clean up the blob URL
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
      toast({
        title: "Download Failed",
        description: "Unable to download the image. Please try again.",
        variant: "destructive"
      });
    }
  };

  const handleImageError = (imageId: string) => {
    setImageLoadErrors(prev => ({ ...prev, [imageId]: true }));
  };

  const handleBackToHome = () => {
    setLocation("/");
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (!user) {
    return null; // Will redirect to home
  }

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Previously Enhanced Photos</h1>
        <Button 
          onClick={handleBackToHome}
          variant="outline"
          data-testid="button-back-home"
        >
          ← Back to Home
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-primary"></div>
          <span className="ml-3 text-gray-600">Loading your photos...</span>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center">
            <svg className="w-5 h-5 text-red-500 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
            </svg>
            <span className="text-red-800">
              {error instanceof Error ? error.message : "Failed to load your photo history"}
            </span>
          </div>
          <Button 
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid="button-retry-fetch"
          >
            Try Again
          </Button>
        </div>
      )}

      {!isLoading && !error && images.length === 0 && (
        <div className="text-center py-12">
          <div className="text-6xl mb-4">📸</div>
          <h3 className="text-xl font-medium text-gray-900 mb-2">
            No enhanced photos yet
          </h3>
          <p className="text-gray-600 mb-6">
            Start enhancing your photos to see them here!
          </p>
          <Button 
            onClick={handleBackToHome}
            className="bg-brand-primary hover:opacity-90 text-white"
            data-testid="button-start-enhancing"
          >
            Start Enhancing Photos
          </Button>
        </div>
      )}

      {!isLoading && !error && images.length > 0 && (
        <div className="space-y-6">
          <div className="text-sm text-gray-600">
            Found {images.length} enhanced photo{images.length !== 1 ? 's' : ''}
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {images.map((image) => (
              <Card key={image.id} className="overflow-hidden" data-testid={`photo-card-${image.id}`}>
                <div className="relative aspect-square">
                  {image.url && !imageLoadErrors[image.id] ? (
                    <img 
                      src={image.url}
                      alt="Enhanced photo"
                      className="w-full h-full object-cover"
                      onError={() => {
                        console.error("Failed to load image:", image.url);
                        handleImageError(image.id);
                      }}
                      data-testid={`img-${image.id}`}
                    />
                  ) : (
                    <div className="w-full h-full bg-brand-light flex items-center justify-center">
                      <div className="text-center">
                        <svg className="w-12 h-12 text-gray-400 mx-auto mb-2" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
                        </svg>
                        <p className="text-gray-500 text-sm">
                          {imageLoadErrors[image.id] ? "Image unavailable" : "No image"}
                        </p>
                      </div>
                    </div>
                  )}
                  
                  {/* Status badge */}
                  <div className="absolute top-2 right-2">
                    <span className={`px-2 py-1 text-xs rounded-full ${
                      image.status === 'completed' 
                        ? 'bg-brand-accent text-green-800' 
                        : image.status === 'failed'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}>
                      {image.status}
                    </span>
                  </div>
                </div>
                
                <div className="p-4">
                  <div className="space-y-2">
                    <div className="text-sm text-gray-600">
                      {formatDate(image.createdAt)}
                    </div>
                    
                    {image.prompt && (
                      <div className="text-sm text-gray-800 line-clamp-2">
                        {image.prompt.length > 80 
                          ? `${image.prompt.substring(0, 80)}...` 
                          : image.prompt
                        }
                      </div>
                    )}
                    
                    <div className="flex gap-2 mt-3">
                      {image.url && !imageLoadErrors[image.id] && (
                        <>
                          <Button
                            onClick={() => window.open(image.url!, '_blank', 'noopener,noreferrer')}
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            data-testid={`button-view-${image.id}`}
                          >
                            View
                          </Button>
                          <Button
                            onClick={() => handleDownload(image.url!, image.id)}
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            data-testid={`button-download-${image.id}`}
                          >
                            Download
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}