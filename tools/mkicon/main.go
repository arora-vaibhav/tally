// mkicon draws Tally's icon (a rounded dark tile with a green "=") and writes tally.ico
// with PNG entries at the sizes Windows asks for. Run from the repo root:
//
//	go run ./tools/mkicon
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
)

func main() {
	sizes := []int{16, 20, 24, 32, 40, 48, 64, 128, 256}
	var pngs [][]byte
	for _, s := range sizes {
		var b bytes.Buffer
		if err := png.Encode(&b, draw(s)); err != nil {
			panic(err)
		}
		pngs = append(pngs, b.Bytes())
	}

	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, []uint16{0, 1, uint16(len(sizes))})
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		dim := byte(s)
		if s >= 256 {
			dim = 0
		}
		ico.Write([]byte{dim, dim, 0, 0})
		binary.Write(&ico, binary.LittleEndian, []uint16{1, 32})
		binary.Write(&ico, binary.LittleEndian, []uint32{uint32(len(pngs[i])), uint32(offset)})
		offset += len(pngs[i])
	}
	for _, p := range pngs {
		ico.Write(p)
	}
	if err := os.WriteFile("tally.ico", ico.Bytes(), 0o644); err != nil {
		panic(err)
	}
}

// draw renders one size with 4x4 supersampling for clean edges.
func draw(size int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	const ss = 4
	tile := color.NRGBA{0x26, 0x28, 0x2c, 255}
	mark := color.NRGBA{0x8f, 0xd9, 0xb6, 255}
	f := float64(size)
	radius := f * 0.22
	pad := f * 0.04
	barW, barH := f*0.52, math.Max(f*0.10, 1.4)
	gap := f * 0.12
	cx := f / 2
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var inTile, inMark int
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					px := float64(x) + (float64(sx)+0.5)/ss
					py := float64(y) + (float64(sy)+0.5)/ss
					if roundRect(px, py, pad, pad, f-2*pad, f-2*pad, radius) {
						inTile++
						for _, top := range []float64{cx - gap/2 - barH, cx + gap/2} {
							if roundRect(px, py, cx-barW/2, top, barW, barH, barH/2) {
								inMark++
							}
						}
					}
				}
			}
			if inTile == 0 {
				continue
			}
			a := float64(inTile) / (ss * ss)
			t := float64(inMark) / float64(inTile)
			img.SetNRGBA(x, y, color.NRGBA{
				R: lerp(tile.R, mark.R, t), G: lerp(tile.G, mark.G, t), B: lerp(tile.B, mark.B, t),
				A: uint8(math.Round(a * 255)),
			})
		}
	}
	return img
}

func lerp(a, b uint8, t float64) uint8 {
	return uint8(math.Round(float64(a) + (float64(b)-float64(a))*t))
}

func roundRect(px, py, x, y, w, h, r float64) bool {
	if px < x || py < y || px > x+w || py > y+h {
		return false
	}
	cx := math.Min(math.Max(px, x+r), x+w-r)
	cy := math.Min(math.Max(py, y+r), y+h-r)
	return (px-cx)*(px-cx)+(py-cy)*(py-cy) <= r*r
}
