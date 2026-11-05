package main

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// A listing link pasted into Tally is fetched here, not by the page, so any site can be read
// (a page cannot fetch another site's pages because of CORS). Only http and https, one page
// at a time, at most 15 MB, and nothing is sent but the request the site reader asked for.

type fetchOpts struct {
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type fetched struct {
	Status int    `json:"status"`
	URL    string `json:"url"` // after redirects
	Type   string `json:"type"`
	Body   string `json:"body"`
}

const fetchLimit = 15 << 20

var fetchClient = &http.Client{Timeout: 40 * time.Second}

func fetchPage(link string, o *fetchOpts) (*fetched, error) {
	u, err := url.Parse(link)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("not a web link")
	}
	if o == nil {
		o = &fetchOpts{}
	}
	method := strings.ToUpper(o.Method)
	if method == "" {
		method = "GET"
	}
	if method != "GET" && method != "POST" {
		return nil, errors.New("only GET and POST")
	}
	var body io.Reader
	if o.Body != "" {
		body = strings.NewReader(o.Body)
	}
	req, err := http.NewRequest(method, u.String(), body)
	if err != nil {
		return nil, err
	}
	// what a browser sends, so sites serve the normal page; French first for Quebec sites
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7")
	for k, v := range o.Headers {
		req.Header.Set(k, v)
	}
	resp, err := fetchClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, fetchLimit+1))
	if err != nil {
		return nil, err
	}
	if len(b) > fetchLimit {
		return nil, errors.New("the page is too large")
	}
	return &fetched{Status: resp.StatusCode, URL: resp.Request.URL.String(), Type: resp.Header.Get("Content-Type"), Body: string(b)}, nil
}
