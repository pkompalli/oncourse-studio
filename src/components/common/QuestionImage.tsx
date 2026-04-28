import { useState } from 'react';
import { ImageIcon, X } from 'lucide-react';

interface QuestionImageProps {
  imageUrl: string;
  imageType?: string;
  imageSource?: string;
}

export default function QuestionImage({ imageUrl, imageType, imageSource }: QuestionImageProps) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-slate-400 my-1">
        <ImageIcon className="w-3.5 h-3.5" />
        <span>Image unavailable</span>
      </div>
    );
  }

  return (
    <>
      <div className="my-2">
        <img
          src={imageUrl}
          alt={imageType || 'Question image'}
          className="max-w-xs max-h-48 rounded-lg border border-slate-200 cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => setExpanded(true)}
          onError={() => setError(true)}
        />
        {(imageType || imageSource) && (
          <div className="flex items-center gap-2 mt-1">
            {imageType && <span className="text-xs text-slate-400">{imageType}</span>}
            {imageSource && <span className="text-xs text-slate-300">· {imageSource}</span>}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setExpanded(false)}
        >
          <div className="relative max-w-4xl max-h-[90vh]">
            <button
              onClick={() => setExpanded(false)}
              className="absolute -top-3 -right-3 p-1.5 bg-white rounded-full shadow-lg hover:bg-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={imageUrl}
              alt={imageType || 'Question image'}
              className="max-w-full max-h-[85vh] rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </>
  );
}
