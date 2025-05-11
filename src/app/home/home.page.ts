import { IonicModule } from '@ionic/angular';
import { CommonModule } from '@angular/common';
import { Component, AfterViewInit, ViewChild, ElementRef } from '@angular/core';
import { NgZone } from '@angular/core';

declare var cv: any;

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule],
})
export class HomePage implements AfterViewInit {
  @ViewChild('canvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('video', { static: false }) videoRef!: ElementRef<HTMLVideoElement>;

  showCamera = false;
  showCroppedImage = false;
  croppedImageUrl: string | null = null;
  cropOpacity = 1;

  // Four clear detection boxes (corners)
  detectionBoxes = [
    { x: 0, y: 0, width: 150, height: 150 }, // top-left
    { x: 0, y: 330, width: 150, height: 150 }, // bottom-left
    { x: 330, y: 0, width: 150, height: 150 }, // top-right
    { x: 330, y: 330, width: 150, height: 150 } // bottom-right
  ];

  constructor(private ngZone: NgZone) {
    
  }


  ngAfterViewInit() {
    if (typeof cv === 'undefined') {
      console.error('OpenCV.js is not loaded!');
      return;
    }

  // No need to draw here; handled in processVideo
  }
  // Call this from your button
  onStartCameraButtonClick() {
    this.showCamera = true;
    setTimeout(() => this.startCameraView(), 0);
  }

  startCameraView() {
    if (!this.videoRef || !this.videoRef.nativeElement) {
      alert('Video element not ready');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Camera not supported');
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ 
        video: { 
          facingMode: 'environment',
          width: { ideal: 640 },
          height: { ideal: 480 }
        } 
      })
      .then((stream) => {
        const video = this.videoRef.nativeElement;
        video.srcObject = stream;
        video.play();
        video.onloadedmetadata = () => {
          // Set video dimensions explicitly
          video.width = 640;
          video.height = 480;
          this.processVideo();
        };
      })
      .catch((err) => {
        console.error('Camera error:', err);
        alert('Error accessing camera: ' + err.message);
      });
}

  drawDetectionBoxes(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.save();
    ctx.globalAlpha = 1.0;
    this.detectionBoxes.forEach(box => {
      ctx.strokeStyle = 'lime';
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    });
    ctx.restore();
  }

  isRectInsideDetectionBoxes(rect: { x: number; y: number; width: number; height: number }) {
    return this.detectionBoxes.some(box => {
      return (
        rect.x >= box.x &&
        rect.y >= box.y &&
        rect.x + rect.width <= box.x + box.width &&
        rect.y + rect.height <= box.y + box.height
      );
    });
  }

  processVideo() {
    try {
        const video = this.videoRef.nativeElement;
        const canvas = this.canvasRef.nativeElement;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            console.error('Could not get canvas context');
            return;
        }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    const FPS = 10;
    let stopped = false;

    const process = () => {
      if (stopped) return;
      if (!video || video.readyState < 2) {
        requestAnimationFrame(process);
        return;
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      this.drawDetectionBoxes(ctx, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      src.data.set(imageData.data);

      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      cv.threshold(gray, gray, 50, 255, cv.THRESH_BINARY); // Only keep pixels darker than 50
      cv.Canny(blurred, edges, 100, 200);
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let detectedBoxes = new Array(this.detectionBoxes.length).fill(false);

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);

        if (approx.rows === 4 && cv.contourArea(approx) > 250 && cv.isContourConvex(approx)) {
          const rect = cv.boundingRect(approx);

          this.detectionBoxes.forEach((box, idx) => {
            if (
              rect.x >= box.x &&
              rect.y >= box.y &&
              rect.x + rect.width <= box.x + box.width &&
              rect.y + rect.height <= box.y + box.height
            ) {
              detectedBoxes[idx] = true;
              ctx.save();
              ctx.strokeStyle = 'red';
              ctx.lineWidth = 4;
              ctx.globalAlpha = 0.7;
              ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
              ctx.fillStyle = 'rgba(255,0,0,0.2)';
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
              ctx.restore();
            }
          });
        }

        approx.delete();
        cnt.delete();
      }

      // In the processVideo function, when all boxes are detected:
      if (detectedBoxes.every(v => v) && !this.croppedImageUrl) {
          stopped = true;
          this.showCamera = false;  // Hide the camera view
          // Stop the camera stream
          if (this.videoRef.nativeElement.srcObject) {
              const stream = this.videoRef.nativeElement.srcObject as MediaStream;
              stream.getTracks().forEach(track => track.stop());
          }
          this.detectAndCropPaper();
          return;
      }

      requestAnimationFrame(process);
    };

    requestAnimationFrame(process);
    } catch (error) {
        console.error('Error in processVideo:', error);
    }
    }

    detectAndCropPaper() {
        const canvas = this.canvasRef.nativeElement;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
  
        // Take a clean snapshot without detection boxes
        const video = this.videoRef.nativeElement;
  
        // Create a temporary canvas for the clean snapshot
        const tempSnapshotCanvas = document.createElement('canvas');
        tempSnapshotCanvas.width = canvas.width;
        tempSnapshotCanvas.height = canvas.height;
        const tempCtx = tempSnapshotCanvas.getContext('2d');
        if (!tempCtx) return;
  
        // Draw only the video frame without any overlays
        tempCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
        // Use the clean snapshot for processing
        let src = cv.imread(tempSnapshotCanvas);
        let dst = new cv.Mat();
  
        // Gather the four corners from detectionBoxes
        const corners = [
            { x: this.detectionBoxes[0].x, y: this.detectionBoxes[0].y }, // top-left
            { x: this.detectionBoxes[2].x + this.detectionBoxes[2].width, y: this.detectionBoxes[2].y }, // top-right
            { x: this.detectionBoxes[1].x, y: this.detectionBoxes[1].y + this.detectionBoxes[1].height }, // bottom-left
            { x: this.detectionBoxes[3].x + this.detectionBoxes[3].width, y: this.detectionBoxes[3].y + this.detectionBoxes[3].height } // bottom-right
        ];
  
        // Sort corners: first by y (top to bottom), then by x (left to right)
        corners.sort((a, b) => a.y - b.y);
        const top = corners.slice(0, 2).sort((a, b) => a.x - b.x);
        const bottom = corners.slice(2, 4).sort((a, b) => a.x - b.x);
        const ordered = [top[0], top[1], bottom[0], bottom[1]];
  
        // Calculate the maximum width and height of the target area
        const width = Math.max(
            Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y),
            Math.hypot(ordered[3].x - ordered[2].x, ordered[3].y - ordered[2].y)
        );
        const height = Math.max(
            Math.hypot(ordered[2].x - ordered[0].x, ordered[2].y - ordered[0].y),
            Math.hypot(ordered[3].x - ordered[1].x, ordered[3].y - ordered[1].y)
        );
  
        // Define the source points using the ordered corners
        let srcPoints = new cv.Mat(4, 1, cv.CV_32FC2);
        srcPoints.data32F[0] = ordered[0].x; // top-left
        srcPoints.data32F[1] = ordered[0].y;
        srcPoints.data32F[2] = ordered[1].x; // top-right
        srcPoints.data32F[3] = ordered[1].y;
        srcPoints.data32F[4] = ordered[2].x; // bottom-left
        srcPoints.data32F[5] = ordered[2].y;
        srcPoints.data32F[6] = ordered[3].x; // bottom-right
        srcPoints.data32F[7] = ordered[3].y;
  
        // Define the destination points for a rectangle
        let dstPoints = new cv.Mat(4, 1, cv.CV_32FC2);
        dstPoints.data32F[0] = 0;         // top-left
        dstPoints.data32F[1] = 0;
        dstPoints.data32F[2] = width;     // top-right
        dstPoints.data32F[3] = 0;
        dstPoints.data32F[4] = 0;         // bottom-left
        dstPoints.data32F[5] = height;
        dstPoints.data32F[6] = width;     // bottom-right
        dstPoints.data32F[7] = height;
  
        // Get perspective transform and apply it
        let M = cv.getPerspectiveTransform(srcPoints, dstPoints);
        cv.warpPerspective(src, dst, M, new cv.Size(width, height));
  
        // Create a canvas and show the result
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        cv.imshow(tempCanvas, dst);
  
        this.ngZone.run(() => {
            this.croppedImageUrl = tempCanvas.toDataURL('image/png');
            this.showCroppedImage = true;
        });
  
        // Cleanup
        src.delete();
        dst.delete();
        M.delete();
        srcPoints.delete();
        dstPoints.delete();
    }

  reset() {
    this.showCamera = false;
    this.showCroppedImage = false;
    this.croppedImageUrl = null;
    // Optionally, stop the camera stream if needed
    if (this.videoRef && this.videoRef.nativeElement && this.videoRef.nativeElement.srcObject) {
      const stream = this.videoRef.nativeElement.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      this.videoRef.nativeElement.srcObject = null;
    }
  }
  }
