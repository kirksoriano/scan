import { Component, AfterViewInit } from '@angular/core';
import { IonicModule } from '@ionic/angular';
import { CommonModule } from '@angular/common';
declare var jsfeat: any;
declare var tracking: any;

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule],
})
export class HomePage implements AfterViewInit {

  video!: HTMLVideoElement;
  canvas!: HTMLCanvasElement;
  ctx!: CanvasRenderingContext2D | null;
  showCamera: boolean = false;
  trackingTask: any = null;
  detectedRect: any = null;
  smoothedRect: { x: number, y: number, width: number, height: number } | null = null;
  smoothingAlpha: number = 0.2; // Smoother overlay
  rectMissedFrames: number = 0;
  maxMissedFrames: number = 60; // Increased for longer persistence
  lastDetectedRect: any = null;
  croppedImageUrl: string | null = null;
  lastCropCorners: {x: number, y: number}[] | null = null;
  cropMissedFrames: number = 0; // NEW: for holding last crop
  lastVelocity: { x: number, y: number, width: number, height: number } | null = null;
  overlayOpacity: number = 1.0;
  cropOpacity: number = 1.0;
  fadeOutStartFrames: number = 15; // Start fading after 15 missed frames
  fadeOutFrames: number = 30;      // Fade out over 30 frames
  detectedRects: { x: number, y: number, width: number, height: number }[] = [];
  smoothedRects: ({ x: number, y: number, width: number, height: number } | null)[] = [null, null, null, null];

  ngAfterViewInit() {
    // Check if jsfeat and tracking are loaded
    if (typeof jsfeat === 'undefined') {
      console.error('jsfeat is not loaded!');
    } else {
      console.log('jsfeat loaded:', jsfeat);

      // Test jsfeat: create a matrix and run canny
      const testMat = new jsfeat.matrix_t(10, 10, jsfeat.U8_t | jsfeat.C1_t);
      for (let i = 0; i < 100; i++) testMat.data[i] = i % 255;
      const edgeMat = new jsfeat.matrix_t(10, 10, jsfeat.U8_t | jsfeat.C1_t);
      jsfeat.imgproc.canny(testMat, edgeMat, 10, 30);
      console.log('jsfeat test edgeMat:', edgeMat.data);
    }
    if (typeof tracking === 'undefined') {
      console.error('tracking.js is not loaded!');
    } else {
      console.log('tracking.js loaded:', tracking);

      // Test tracking.js: create a tracker and simulate a 'track' event
      const tracker = new tracking.ColorTracker(['magenta']);
      tracker.on('track', (event: any) => {
        console.log('tracking.js test event:', event);
      });
      tracker.emit('track', { data: [{ x: 1, y: 2, width: 3, height: 4 }] });
    }
    // No OpenCV.js initialization needed
  }

  startCameraView() {
    this.showCamera = true;
    setTimeout(() => this.initializeCamera(), 100);
  }

  async initializeCamera() {
    this.video = document.getElementById('cameraFeed') as HTMLVideoElement;
    this.canvas = document.getElementById('overlayCanvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d');

    if (!this.video || !this.canvas || !this.ctx) {
      console.error('Camera or canvas elements not found!');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } } // <-- REMOVE focusMode
      });

      this.video.srcObject = stream;

      this.video.onloadedmetadata = () => {
        this.video.play();
        const updateDimensions = () => {
          this.canvas.width = this.video.videoWidth;
          this.canvas.height = this.video.videoHeight;
        };

        updateDimensions();
        window.addEventListener('resize', updateDimensions);

        this.startTracking();
        this.startFrameProcessing();
      };
    } catch (err) {
      console.error('Camera access error:', err);
    }
  }

  startTracking() {
    // Use tracking.js to detect rectangles (color-based for demo, e.g., white)
    if (typeof tracking === 'undefined') {
      console.error('tracking.js is not loaded!');
      return;
    }
    const tracker = new tracking.ColorTracker(['magenta']);
    tracker.setMinDimension(50); // adjust as needed
    tracker.setMinGroupSize(30); // adjust as needed

    tracker.on('track', (event: any) => {
      if (event.data.length > 0) {
        // Use the largest detected rectangle
        this.detectedRect = event.data.reduce((max: any, rect: any) =>
          rect.width * rect.height > max.width * max.height ? rect : max, event.data[0]);
      } else {
        this.detectedRect = null;
      }
    });

    this.trackingTask = tracking.track(this.video, tracker, { camera: false });
  }

  // Ramer–Douglas–Peucker algorithm for polygon approximation
  rdp(points: number[][], epsilon: number): number[][] {
    if (points.length < 3) return points;
    let dmax = 0;
    let index = 0;
    const end = points.length - 1;
    for (let i = 1; i < end; i++) {
      const d = this.perpendicularDistance(points[i], points[0], points[end]);
      if (d > dmax) {
        index = i;
        dmax = d;
      }
    }
    if (dmax > epsilon) {
      const recResults1 = this.rdp(points.slice(0, index + 1), epsilon);
      const recResults2 = this.rdp(points.slice(index, end + 1), epsilon);
      return recResults1.slice(0, -1).concat(recResults2);
    } else {
      return [points[0], points[end]];
    }
  }

  perpendicularDistance(pt: number[], lineStart: number[], lineEnd: number[]): number {
    const dx = lineEnd[0] - lineStart[0];
    const dy = lineEnd[1] - lineStart[1];
    if (dx === 0 && dy === 0) {
      return Math.hypot(pt[0] - lineStart[0], pt[1] - lineStart[1]);
    }
    const t = ((pt[0] - lineStart[0]) * dx + (pt[1] - lineStart[1]) * dy) / (dx * dx + dy * dy);
    const nearestX = lineStart[0] + t * dx;
    const nearestY = lineStart[1] + t * dy;
    return Math.hypot(pt[0] - nearestX, pt[1] - nearestY);
  }

  startFrameProcessing() {
    const FPS = 10;
    const areaRatio = 0.2;

    setInterval(() => {
      if (!this.video || !this.ctx || !this.video.videoWidth) return;

      const width = this.video.videoWidth;
      const height = this.video.videoHeight;
      const alignW = width * areaRatio;
      const alignH = height * areaRatio;

      // Move bottom rectangles upwards (e.g., 20% of height)
      const verticalOffset = height * 0.15;

      const alignRects = [
        { x: 0, y: 0 }, // top-left
        { x: width - alignW, y: 0 }, // top-right
        { x: 0, y: height - alignH - verticalOffset }, // bottom-left (moved up)
        { x: width - alignW, y: height - alignH - verticalOffset } // bottom-right (moved up)
      ];

      // Draw video frame
      this.ctx.drawImage(this.video, 0, 0, width, height);

      // --- Dim the background ---
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(0,0,0,0.55)';
      this.ctx.fillRect(0, 0, width, height);
      this.ctx.restore();

      // --- Draw lighter/clearer rectangles in corners ---
      this.ctx.save();
      this.ctx.globalAlpha = 0.85;
      this.ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      this.ctx.lineWidth = 6;
      this.ctx.fillStyle = 'rgba(255,255,255,0.18)';
      // --- Draw lighter/clearer rectangles in corners ---
      // (Removed both fillRect and strokeRect for no border, no fill)
      // alignRects.forEach(r => {
      //   this.ctx!.fillRect(r.x, r.y, alignW, alignH);
      //   this.ctx!.strokeRect(r.x, r.y, alignW, alignH);
      // });
      this.ctx.restore();

      // --- Rectangle and edge detection using OpenCV.js ---
      if (this.processFrameWithOpenCV) {
        this.processFrameWithOpenCV();
      }

      // --- Draw overlays for detected black-filled rectangles only ---
      if (this.detectedRects && Array.isArray(this.detectedRects)) {
        for (let k = 0; k < this.detectedRects.length; k++) {
          const rect = this.detectedRects[k];
          if (rect && this.ctx) {
            // Smoothing per rect
            if (!this.smoothedRects[k]) {
              this.smoothedRects[k] = { ...rect };
            } else {
              this.smoothedRects[k] = {
                x: this.smoothingAlpha * rect.x + (1 - this.smoothingAlpha) * this.smoothedRects[k]!.x,
                y: this.smoothingAlpha * rect.y + (1 - this.smoothingAlpha) * this.smoothedRects[k]!.y,
                width: this.smoothingAlpha * rect.width + (1 - this.smoothingAlpha) * this.smoothedRects[k]!.width,
                height: this.smoothingAlpha * rect.height + (1 - this.smoothingAlpha) * this.smoothedRects[k]!.height,
              };
            }
            const sRect = this.smoothedRects[k]!;
            this.ctx.save();
            this.ctx.globalAlpha = 1.0;
            this.ctx.strokeStyle = 'rgba(0,255,0,0.9)'; // Green border
            this.ctx.lineWidth = 6;
            this.ctx.strokeRect(sRect.x, sRect.y, sRect.width, sRect.height);
            this.ctx.fillStyle = 'rgba(0,255,0,0.15)'; // Light green fill
            this.ctx.fillRect(sRect.x, sRect.y, sRect.width, sRect.height);
            this.ctx.restore();
          } else {
            this.smoothedRects[k] = null;
          }
        }
      }
    }, 1000 / FPS);
  }

  processFrameWithOpenCV() {
    if (typeof cv === 'undefined' || !this.canvas || !this.ctx) return;
  
    const src = cv.imread(this.canvas);
    const gray = new cv.Mat();
    const denoised = new cv.Mat();
    const equalized = new cv.Mat();
    const thresh = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
  
    // Preprocessing: denoise and equalize
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(gray, denoised, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.equalizeHist(denoised, equalized);
  
    cv.adaptiveThreshold(
      equalized,
      thresh,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      11,
      2
    );
    cv.Canny(thresh, edges, 80, 200); // Increased thresholds
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  
    // Alignment rectangles (MATCH startFrameProcessing)
    const width = this.canvas.width;
    const height = this.canvas.height;
    const areaRatio = 0.2;
    const alignW = width * areaRatio;
    const alignH = height * areaRatio;
    const verticalOffset = height * 0.15;
    const alignRects = [
      { x: 0, y: 0 }, // top-left
      { x: width - alignW, y: 0 }, // top-right
      { x: 0, y: height - alignH - verticalOffset }, // bottom-left (moved up)
      { x: width - alignW, y: height - alignH - verticalOffset } // bottom-right (moved up)
    ];
    
    // For each alignment rect, find the largest black rectangle inside it
    let detectedRects: { x: number, y: number, width: number, height: number }[] = [];
    let detectedCorners: { x: number, y: number }[][] = [];
  
    for (let k = 0; k < alignRects.length; k++) {
      const r = alignRects[k];
      let largest: { rect: any, points: { x: number, y: number }[] } | null = null;
      for (let i = 0; i < contours.size(); ++i) {
        const cnt = contours.get(i);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
        if (approx.rows === 4 && cv.contourArea(approx) > 20) { // Lowered area threshold
          const rect = cv.boundingRect(approx);
          const aspect = rect.width / rect.height;
          if (aspect > 0.5 && aspect < 2.0) {
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;
            // Check if center is inside this alignment rect
            if (
              cx >= r.x && cx <= r.x + alignW &&
              cy >= r.y && cy <= r.y + alignH
            ) {
              const roi = gray.roi(rect);
              const meanScalar = cv.mean(roi);
              roi.delete();
              if (meanScalar[0] < 50) {
                if (
                  !largest ||
                  rect.width * rect.height > largest.rect.width * largest.rect.height
                ) {
                  let points: { x: number, y: number }[] = [];
                  for (let j = 0; j < 4; j++) {
                    points.push({ x: approx.intPtr(j, 0)[0], y: approx.intPtr(j, 0)[1] });
                  }
                  largest = { rect, points };
                }
              }
            }
          }
        }
        approx.delete();
        cnt.delete();
      }
      if (largest) {
        detectedRects[k] = largest.rect;
        detectedCorners.push(largest.points);
      } else {
        detectedCorners.push([]);
      }
    }

    // Draw overlays for all detected rectangles (one per corner)
    this.detectedRects = detectedRects.filter(r => r !== null) as any;
  
    // --- Cropping if all 4 rectangles detected ---
    if (detectedCorners.every(c => c.length === 4)) {
      // All four corners detected
      let centers = detectedCorners.map(pts => {
        let cx = pts.reduce((sum, p) => sum + p.x, 0) / 4;
        let cy = pts.reduce((sum, p) => sum + p.y, 0) / 4;
        return { cx, cy, pts };
      });
      centers.sort((a, b) => a.cy - b.cy);
      let top = centers.slice(0, 2).sort((a, b) => a.cx - b.cx);
      let bottom = centers.slice(2, 4).sort((a, b) => a.cx - b.cx);
  
      let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        top[0].pts[0].x, top[0].pts[0].y, // top-left
        top[1].pts[1].x, top[1].pts[1].y, // top-right
        bottom[0].pts[2].x, bottom[0].pts[2].y, // bottom-left
        bottom[1].pts[3].x, bottom[1].pts[3].y  // bottom-right
      ]);
      let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        width, 0,
        0, height,
        width, height
      ]);
      let M = cv.getPerspectiveTransform(srcTri, dstTri);
      let dst = new cv.Mat();
      cv.warpPerspective(src, dst, M, new cv.Size(width, height));
      cv.imshow(this.canvas, dst);
  
      // Only update croppedImageUrl when a new crop is detected
      this.croppedImageUrl = this.canvas.toDataURL();
  
      srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
      // Store last valid crop corners as a flat array (for example, top-left, top-right, bottom-left, bottom-right)
      this.lastCropCorners = [
        { x: top[0].pts[0].x, y: top[0].pts[0].y },
        { x: top[1].pts[1].x, y: top[1].pts[1].y },
        { x: bottom[0].pts[2].x, y: bottom[0].pts[2].y },
        { x: bottom[1].pts[3].x, y: bottom[1].pts[3].y }
      ];
    } else if (this.lastCropCorners) {
      // Show last valid crop if available
      // (Optional: you could re-crop using lastCropCorners if you want to keep showing the crop)
      // For now, do nothing, so the crop stays visible
    }

    src.delete(); gray.delete(); denoised.delete(); equalized.delete(); thresh.delete(); edges.delete(); contours.delete(); hierarchy.delete();
  }
}